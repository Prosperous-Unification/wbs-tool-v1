import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_PRIORITY_BANDS } from '@wbs/domain/priority-band';
import type { IsoDate } from '@wbs/domain/workday';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  Days,
  PersonView,
  ProjectApi,
  RoleView,
  SliceView,
  TeamView,
  WorkItemView,
} from '@/lib/wbs-api';

import type { GanttPlan, GanttRow, GanttSlice } from './gantt-geometry';
import { PERSON_BAR_COLORS, UNASSIGNED_BAR_COLOR } from './gantt-geometry';
import {
  axisNumberShown,
  barLabelFor,
  barText,
  CHART_PAD_PX,
  clampedGanttHeight,
  DAY_PX,
  DAY_SCALES,
  FALLBACK_GANTT_THEME,
  GANTT_CEILING_PX,
  GANTT_MIN_PX,
  GanttPanel,
  ganttSvgFileName,
  initialsOf,
  isDayPx,
  isoToday,
  LABEL_COLUMN_PX,
  monthWords,
  ROW_PX,
  rowWords,
} from './gantt-panel';
import { type SubscriptionHandlers, WbsTable } from './wbs-table';

// fe-01 tests require jsdom; only Vitest provides it. Skip under plain `bun test`.
const hasDom = typeof document !== 'undefined';
const itDom = hasDom ? it : it.skip;

/** A shown row: a leaf over these workdays, unless `extras` says otherwise. */
const rowAt = (
  id: string,
  earliestStart: number,
  earliestFinish: number,
  extras: Partial<GanttRow> = {},
): GanttRow => ({
  id,
  number: id,
  name: id,
  depth: 0,
  leaf: true,
  schedule: { earliestStart, earliestFinish },
  notBeforeOffset: null,
  priority: null,
  maxParallel: 1,
  // The facts a row is enriched with before the chart is drawn. Absent by
  // default and named by the tests that are about them, so a fixture never has
  // to state a team it is not asking about.
  team: { state: 'none' },
  tags: { state: 'none' },
  trioByRole: new Map(),
  waitsFor: [],
  ...extras,
});

/** A scheduled slice over these workdays, under the `dev` role. */
const sliceAt = (
  id: string,
  workItemId: string,
  earliestStart: number,
  earliestFinish: number,
  extras: Partial<GanttSlice> = {},
): GanttSlice => ({
  id,
  workItemId,
  roleId: 'dev',
  personId: null,
  duration: earliestFinish - earliestStart,
  estimated: true,
  earliestStart,
  earliestFinish,
  float: 0,
  critical: false,
  boundBy: 'projectStart',
  resourcePredecessorId: null,
  width: 1,
  effort: earliestFinish - earliestStart,
  capacityPredecessorIds: [],
  ...extras,
});

/**
 * The full tree a fixture's shown rows imply: each row's parent is the
 * nearest shallower row above it — enough for every plan in this file, whose
 * predecessors are all shown.
 */
const treeFrom = (rows: readonly GanttRow[]): { id: string; parentId: string | null }[] => {
  const above: { id: string; depth: number }[] = [];
  return rows.map((row) => {
    while (above.length > 0 && above[above.length - 1].depth >= row.depth) above.pop();
    const parentId = above.length > 0 ? above[above.length - 1].id : null;
    above.push({ id: row.id, depth: row.depth });
    return { id: row.id, parentId };
  });
};

const planOf = (parts: Partial<GanttPlan>): GanttPlan => ({
  rows: [],
  slices: [],
  dependencies: [],
  tree: treeFrom(parts.rows ?? []),
  // Off unless a test is about the sentence a filter's dropped waits earn.
  narrowedByFilter: false,
  roles: [{ id: 'dev', name: 'Dev' }],
  personNames: new Map(),
  priorityBands: DEFAULT_PRIORITY_BANDS,
  ...parts,
});

const barFor = (sliceId: string): Element | null =>
  document.querySelector(`[data-gantt-bar="${sliceId}"]`);

/**
 * One bar of the chart, or a throw naming the one that is not there.
 *
 * A throw rather than a null the assertion then optional-chains through: a
 * hover opened on nothing would leave every `expect` below reading `undefined`
 * and failing as an argument error rather than as anything about the chart.
 */
function markFor(sliceId: string): Element {
  const bar = barFor(sliceId);
  if (bar === null) throw new Error(`no bar on the chart for ${sliceId}`);
  return bar;
}

/**
 * Opens a bar's surface the way the keyboard does, and hands it back.
 *
 * The focus and not the pointer, in every test that is about the **words**: it
 * carries no delay, so nothing here has to run a timer to read a sentence. The
 * pointer's own path — the delay, its cancellation and the touch seam — has
 * tests of its own further down.
 */
function surfaceOn(sliceId: string): HTMLElement {
  fireEvent.focus(markFor(sliceId));
  return screen.getByRole('tooltip');
}

/** Every line of an open surface, in the order it shows them. */
const linesOf = (surface: HTMLElement): string[] =>
  [...surface.querySelectorAll('p')].map((line) => line.textContent);

/**
 * A bar's accessible name, or a sentence saying it has none.
 *
 * A sentence rather than the `null` `getAttribute` answers, for
 * {@link markAttribute}'s reason: `expect(null).toContain(…)` fails as an
 * invalid **assertion** rather than as anything about the chart, and the
 * message then names neither the bar nor the fact that went missing. Watched
 * with the `aria-label` deleted, 2026-08-09.
 */
const labelOf = (bar: Element): string =>
  bar.getAttribute('aria-label') ?? 'this bar carries no accessible name at all';

/** Whether any surface is open anywhere on the page. */
const noSurface = (): boolean => screen.queryByRole('tooltip') === null;

/**
 * Presses the detail switch, which is what puts an arrow, a parent's bracket or
 * an unestimated slice's bar on the chart at all since `declutter-one-button`.
 *
 * The chart opens with none of the three, so every assertion below about an
 * elbow, a head, a bracket, an assumed bar or the canvas one routes off has to
 * ask for them first. The throws are the point: a helper that quietly did
 * nothing would leave those assertions reading a chart with none of it drawn and
 * failing as arguments rather than as geometry, and the run before this one
 * would look the same as the run after.
 *
 * @param drew the mark this caller is asking for, as a selector — the arrows for
 * most of them, and the bracket or the assumed bar for a fixture that has no
 * dependency in it. One of them has to arrive, or the press did nothing.
 */
function askForTheDetail(drew = '[data-gantt-arrow]'): void {
  const toggle = document.querySelector('[data-gantt-detail-toggle]');
  if (!(toggle instanceof HTMLElement)) throw new Error('the detail switch is not on the panel');
  fireEvent.click(toggle);
  if (document.querySelector(drew) === null) {
    throw new Error(`the detail switch was pressed and nothing arrived at ${drew}`);
  }
}

/**
 * One attribute of one mark on the chart, or a sentence saying the mark is not
 * there at all.
 *
 * A sentence rather than `undefined` so that a deleted mark fails as a value
 * that is not the value expected. `expect(undefined).toContain(…)` fails as an
 * invalid **assertion** — the check does break, but on chai's own argument
 * checking rather than on anything about the chart, and the message names
 * neither the mark nor the day it should have been on. Watched, both ways,
 * 2026-08-09.
 */
const markAttribute = (selector: string, attribute: string): string =>
  document.querySelector(selector)?.getAttribute(attribute) ??
  `nothing on the chart at ${selector}`;

/**
 * The four numbers of the chart's `viewBox`, as numbers.
 *
 * A throw rather than zeroes for a chart that is not there: every assertion
 * about where a mark falls is relative to this box, and a box of zeroes would
 * make all of them pass against a chart nobody drew.
 */
function viewBoxOf(svg: Element | null): {
  minX: number;
  minY: number;
  width: number;
  height: number;
} {
  const parts = svg?.getAttribute('viewBox')?.split(' ').map(Number);
  if (parts?.length !== 4) {
    throw new Error(`no viewBox on the chart: ${String(svg?.getAttribute('viewBox'))}`);
  }
  return { minX: parts[0], minY: parts[1], width: parts[2], height: parts[3] };
}

const LAPTOP = 1024;
/** An iPhone 14's CSS width, the one `e2e/mobile.spec.ts` measures at. */
const PHONE = 390;

/** Sets the width the next render will read, before anything is on screen. */
function widthIs(width: number): void {
  (window as unknown as { innerWidth: number }).innerWidth = width;
}

beforeEach(() => {
  localStorage.clear();
  widthIs(LAPTOP);
});

afterEach(() => {
  cleanup();
  widthIs(LAPTOP);
});

/**
 * The Monday every calendar fixture in this file begins on.
 *
 * Every coordinate asserted against it is taken at an offset **past the first
 * weekend**, where the calendar number and the workday number differ. An
 * assertion at workday 3 passes unchanged on the axis this change replaced and
 * so proves nothing.
 */
const MONDAY_START = '2026-08-10';

/**
 * One mark's box on the chart, refused when it has no area.
 *
 * The sixteenth check's own lesson, made unskippable: an overlap comparison
 * against a mark of no width cannot fail, and the mark that had no width was an
 * unestimated bar. Every geometry assertion below goes through this, so a mark
 * that stopped being drawn fails as a mark that is not there rather than as a
 * comparison that quietly holds.
 *
 * @throws When the mark is not on the chart, or is drawn with no width or no
 * height.
 */
function drawnBox(selector: string): { x: number; width: number; y: number; height: number } {
  const mark = document.querySelector(selector);
  if (mark === null) throw new Error(`nothing on the chart at ${selector}`);
  const numberOf = (attribute: string): number => Number(mark.getAttribute(attribute));
  const box = {
    x: numberOf('x'),
    width: numberOf('width'),
    y: numberOf('y'),
    height: numberOf('height'),
  };
  if (!(box.width > 0) || !(box.height > 0)) {
    throw new Error(
      `${selector} is drawn with no area: ${String(box.width)}×${String(box.height)}`,
    );
  }
  return box;
}

/**
 * Every mark that carries a horizontal coordinate, on one plan, at one day.
 *
 * `sand` starts at workday 5 — the Monday after the plan's first weekend, seven
 * calendar days in — and is held there by a date of its own, waits on `strip`
 * across the weekend, and shares Kat with it. `trim` is estimated at no days on
 * the same workday, which is what draws a tick. `hull` spans the branch, so its
 * bracket ends at the end of workday 7.
 *
 * One fixture and one test on purpose: the eight marks are eight `map`s in the
 * SVG, and each of them can be reverted to its raw workday number on its own.
 * See the `Proof:` below.
 */
const everyMarkOnOneDay = (): GanttPlan =>
  planOf({
    rows: [
      rowAt('hull', 0, 7, { leaf: false }),
      rowAt('strip', 0, 5, { depth: 1 }),
      rowAt('sand', 5, 7, { depth: 1, notBeforeOffset: 5 }),
      rowAt('trim', 5, 5),
    ],
    slices: [
      sliceAt('strip-dev', 'strip', 0, 5, { personId: 'kat' }),
      sliceAt('sand-dev', 'sand', 5, 7, {
        personId: 'kat',
        boundBy: 'person',
        resourcePredecessorId: 'strip-dev',
      }),
      sliceAt('trim-dev', 'trim', 5, 5, { duration: 0 }),
    ],
    dependencies: [{ predecessorId: 'strip', successorId: 'sand' }],
    personNames: new Map([['kat', 'Kat']]),
  });

describe('every mark on the chart lands on the calendar day its workday is', () => {
  itDom('puts the bar, the caret, the tick, the axis cell and the label on day 7', () => {
    render(
      <GanttPanel
        plan={everyMarkOnOneDay()}
        startDate={MONDAY_START}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    // The arrow marks and the parent's bracket are drawn only once somebody
    // asks for them (`declutter-one-button`), and this test is about where they
    // land.
    askForTheDetail();

    // Workday 5 is Monday 2026-08-17, and the chart is a calendar: seven days
    // in. Every mark below is on that one day, and each of them is drawn by a
    // block of its own that could be left reading the workday number.
    //
    // Proof, **eight faults, eight runs**, each mark reverted to its raw
    // workday number in turn and each watched failing this test alone —
    // `1 failed | 44 passed` every time. Watched 2026-08-09:
    //   bar          `x={bar.start}`              — `expected 5 to be 7`
    //   caret        `flag.workday`               — `expected 'M 5 2.03 L 5.285714285714286 2.09 L 5…' to match /^M 7 /`
    //   tick         `x1={bar.start}`             — `expected '5' to be '7'`
    //   label        `left: bar.start * DAY_PX`   — `expected 'color: rgb(255, …); left: 152p…' to contain 'left: 208px'`
    //   bracket      `chart.brackets`             — `expected 'M 0 0.5 L 0 0.18 L 7 0.18 L 7 0.5' to contain 'L 9 0.18'` (a path then; the ghost rect now, asserted below)
    //   arrow route  `arrow.toStart`              — `expected 'M 5 1.5 L 5.357142857142857 1.5 L 5.3…' to contain 'L 7 2.5'`
    //   arrow head   `arrow.toStart`              — `expected 'M 5 2.5 L 4.75 2.375 L 4.75 2.625 Z' to match /^M 7 /`
    //   person link  `chart.personLinks`          — `expected 'M 5 1.5 L 5 2.5' to be 'M 5 1.5 L 7 2.5'`
    const bar = drawnBox('[data-gantt-bar="sand-dev"]');
    expect(bar.x).toBe(7);
    // Two workdays with no weekend in them: the Monday and the Tuesday.
    expect(bar.width).toBe(2);
    expect(markAttribute('[data-gantt-not-before="2"]', 'd')).toMatch(/^M 7 /);
    expect(markAttribute('[data-gantt-tick="trim-dev"]', 'x1')).toBe('7');
    expect(
      document.querySelector('[data-gantt-bar-label="sand-dev"]')?.getAttribute('style'),
    ).toContain(`left: ${String(7 * DAY_PX + CHART_PAD_PX)}px`);

    // The axis cell above them, which is the mark that makes a mark left on
    // workdays visible: cell 7 is the Monday, and it is workday 5.
    expect(markAttribute('[data-axis-day="7"]', 'data-axis-date')).toBe('2026-08-17');
    expect(markAttribute('[data-axis-day="7"]', 'data-axis-workday')).toBe('5');

    // The parent's bracket, which the detail switch has just drawn: `hull`
    // spans workdays 0 → 7, and workday 7 is calendar day 9 — the second Monday
    // — so the ghost stops there rather than at the 7 its workday number reads.
    // The same conversion the bar above is asserted through, one mark along.
    const bracket = drawnBox('[data-gantt-bracket="hull"]');
    expect(bracket.x).toBe(0);
    expect(bracket.x + bracket.width).toBe(9);
    expect(Math.floor(bracket.y)).toBe(0);

    // And the three marks joining two rows: the arrow leaves the Friday's right
    // edge at 5 and arrives at the Monday at 7, so the weekend is the gap.
    expect(markAttribute('[data-gantt-arrow="strip->sand"]', 'd')).toContain('L 7 2.5');
    expect(markAttribute('[data-gantt-arrow-head="strip->sand"]', 'd')).toMatch(/^M 7 /);
    expect(markAttribute('[data-gantt-person-link="strip-dev->sand-dev"]', 'd')).toBe(
      'M 5 1.5 L 7 2.5',
    );
  });

  itDom('refuses to compare a mark that has no area', () => {
    render(
      <GanttPanel
        plan={everyMarkOnOneDay()}
        startDate={MONDAY_START}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    // `trim-dev` is estimated at no days, so its rect is the zero-width mark the
    // sixteenth check compared an overlap against and could not fail. The helper
    // every geometry assertion above goes through says so instead of measuring
    // it.
    //
    // Proof: the area guard in {@link drawnBox} removed — this test alone
    // failed, on `expected [Function] to throw an error`, and the box it handed
    // back was `{ x: 7, width: 0, … }`, which every overlap comparison in this
    // file would have held against. Watched 2026-08-09.
    expect(() => drawnBox('[data-gantt-bar="trim-dev"]')).toThrow(/drawn with no area/);
    expect(() => drawnBox('[data-gantt-bar="nobody-drew-this"]')).toThrow(/nothing on the chart/);
  });
});

/**
 * The reviewed coordinate contract, asserted where it can be (codex #15).
 *
 * Strict string equality against numbers written by hand into the fixture, not
 * `toBeCloseTo` and not a comparison against something recomputed here: the
 * whole point of a user space measured in workdays is that the engine's number
 * reaches the attribute untouched. A pixel would have to round.
 */
describe('the chart is drawn in calendar days', () => {
  itDom('puts a 3.5→6 slice at x=3.5 with a width of 4.5, and says so twice', () => {
    render(
      <GanttPanel
        plan={planOf({
          rows: [rowAt('strip', 3.5, 6)],
          slices: [sliceAt('strip-dev', 'strip', 3.5, 6, { duration: 2.5 })],
        })}
        startDate={MONDAY_START}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    const bar = barFor('strip-dev');
    // The fraction rides inside the workday it belongs to, so a slice 3.5
    // workdays in is still 3.5 calendar days in — the Thursday, half gone. It
    // works through the Friday and the Monday after, so its **drawn** width is
    // 4.5: the weekend it is on both sides of is drawn across.
    //
    // Proof: `x` computed as `bar.start * DAY_PX` and `width` as
    // `bar.duration * DAY_PX` — the pixel arithmetic design §1 rejects. This
    // test alone failed, on `expected '98' to be '3.5'`, and `data-start` went
    // on saying 3.5 beside it — exactly the drift the two-place contract exists
    // to catch. Watched, 2026-08-09.
    expect(bar?.getAttribute('x')).toBe('3.5');
    expect(bar?.getAttribute('width')).toBe('4.5');
    // And the engine's own numbers, untouched by the conversion above them.
    expect(bar?.getAttribute('data-start')).toBe('3.5');
    expect(bar?.getAttribute('data-finish')).toBe('6');
  });

  itDom('gives the SVG a user space of the calendar horizon by the rows', () => {
    render(
      <GanttPanel
        plan={planOf({
          rows: [rowAt('strip', 0, 3), rowAt('sand', 3, 6)],
          slices: [sliceAt('strip-dev', 'strip', 0, 3), sliceAt('sand-dev', 'sand', 3, 6)],
        })}
        startDate={MONDAY_START}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    const svg = document.querySelector('[data-gantt-chart]');
    // Six workdays is eight calendar days once the weekend inside them is
    // drawn — plus the band the canvas keeps at either side for the marks that
    // step outside the schedule (see {@link CHART_PAD_PX}).
    const pad = CHART_PAD_PX / DAY_PX;
    expect(svg?.getAttribute('viewBox')).toBe(
      `${String(-pad)} 0 ${String(8 + 2 * pad)} ${String(2)}`,
    );
    // The band said in pixels, which is the unit it is decided in: the canvas
    // starts one band left of day 0 and ends one band past the horizon.
    // `toBeCloseTo` only because `-pad + 8 + 2·pad` is not exact in binary
    // floating point — the assertion is exact arithmetic, not a tolerance for
    // drift.
    const box = viewBoxOf(svg);
    expect(-box.minX * DAY_PX).toBeCloseTo(CHART_PAD_PX, 10);
    expect((box.minX + box.width - 8) * DAY_PX).toBeCloseTo(CHART_PAD_PX, 10);
    expect(svg?.getAttribute('preserveAspectRatio')).toBe('none');

    // The axis holds one cell per calendar day of that band, counted against
    // the **canvas** rather than against a constant — and the two are computed
    // apart in the panel, from the axis's own length and from the horizon the
    // marks were placed against, which is what lets this assertion fail at all.
    //
    // Proof: the axis built from `chart.horizon` — the engine's six workdays —
    // while the canvas kept the calendar horizon. This test alone failed, on
    // `expected …(6) to have a length of 8 but got 6`: the axis two cells short
    // of the chart under it, and every date label two days right of the bar it
    // belongs to. Watched 2026-08-09. Watched **passing** first, with the
    // canvas sized from the axis's own count — a fault that moves both cannot
    // be seen by comparing them, which is why the canvas is not sized from the
    // axis.
    const cells = document.querySelectorAll('[data-axis-day]');
    expect(cells).toHaveLength(Math.ceil(box.width - 2 * pad));
    // Cell `k` stands at user-space `x = k`, which is what the gridline beside
    // it says: the two arrangements are one scale or they are two.
    expect([...cells].map((cell) => cell.getAttribute('data-axis-day'))).toEqual(
      [...document.querySelectorAll('[data-gantt-gridline]')].map((line) =>
        line.getAttribute('x1'),
      ),
    );
    // And the CSS width is the band through {@link DAY_PX}, so one user unit is
    // exactly one day of screen and the axis row above cannot be a different
    // width from the chart it labels.
    expect(svg?.getAttribute('width')).toBe(String(8 * DAY_PX + 2 * CHART_PAD_PX));
  });

  /**
   * The critical path is an outline, not a fill, because the fill is the
   * assignee — and this is the assertion that says the mark is present on the
   * critical bar and absent off it, which is the whole of the spec's "tinted
   * so".
   */
  itDom('rings the critical bar and leaves the other one alone', () => {
    render(
      <GanttPanel
        plan={planOf({
          rows: [rowAt('strip', 0, 3), rowAt('sand', 0, 2)],
          slices: [
            sliceAt('strip-dev', 'strip', 0, 3, { critical: true, personId: 'kat' }),
            sliceAt('sand-dev', 'sand', 0, 2, { personId: 'kat' }),
          ],
          personNames: new Map([['kat', 'Kat']]),
        })}
        startDate={null}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    // The mark by name, not a `data-` attribute standing in for it: an attribute
    // could be right while the bar drew like every other one.
    //
    // Proof: `barClasses` returning '' for a critical bar — the `data-critical`
    // attribute still on it and the ring gone. This test alone failed, on
    // `expected false to be true`, and the browser gate's own selector went on
    // finding the bar. Watched, 2026-08-09.
    expect(barFor('strip-dev')?.classList.contains('stroke-foreground')).toBe(true);
    expect(barFor('sand-dev')?.classList.contains('stroke-foreground')).toBe(false);
    // And both keep Kat's colour: the critical path costs the reader nothing
    // about who is on it.
    expect(barFor('strip-dev')?.getAttribute('fill')).toBe(PERSON_BAR_COLORS[0]);
    expect(barFor('sand-dev')?.getAttribute('fill')).toBe(PERSON_BAR_COLORS[0]);
  });

  itDom('paints a bar in its person’s colour, and an unassigned one grey', () => {
    render(
      <GanttPanel
        plan={planOf({
          rows: [rowAt('strip', 0, 3), rowAt('sand', 0, 2), rowAt('trim', 0, 2)],
          slices: [
            sliceAt('strip-dev', 'strip', 0, 3, { personId: 'kat' }),
            sliceAt('sand-dev', 'sand', 0, 2, { personId: 'ravi' }),
            sliceAt('trim-dev', 'trim', 0, 2),
          ],
          personNames: new Map([
            ['kat', 'Kat'],
            ['ravi', 'Ravi'],
          ]),
        })}
        startDate={null}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    // Proof: `fill={bar.estimated ? bar.personColor : 'none'}` replaced by
    // `fill="currentColor"` — every bar one colour, which is what the chart
    // looked like before this change. **Three** tests failed and the run said
    // `3 failed | 22 passed`: this one and `rings the critical bar…` on
    // `expected 'currentColor' to be '#1f77b4'`, and `draws an unestimated
    // slice hollow…` on `expected 'currentColor' to be 'none'` — the hollow
    // bar filled in as well, which only that third test can see. Watched,
    // 2026-08-09.
    expect(barFor('strip-dev')?.getAttribute('fill')).toBe(PERSON_BAR_COLORS[0]);
    expect(barFor('sand-dev')?.getAttribute('fill')).toBe(PERSON_BAR_COLORS[1]);
    expect(barFor('trim-dev')?.getAttribute('fill')).toBe(UNASSIGNED_BAR_COLOR);
  });

  /**
   * The slice nobody costed, and the mark it gets only when it is asked for.
   *
   * It is drawn across an assumed span of two workdays, translucent and dashed,
   * with a `?` on it — two of every three bars on a fresh plan, each of them a
   * width nobody gave. Dany named them clutter, so at rest the chart's answer is
   * nothing at all and the plan's own `?` cells are where unestimated work is
   * found; the detail switch is how a reader asks for them back
   * (`declutter-one-button`).
   *
   * Both halves on one render, which is the whole R5 shape of a gate: the
   * absence alone passes against a gate wired to nothing, and the presence alone
   * passes against a chart with no gate in it.
   */
  itDom('draws no mark for a slice nobody estimated until the detail is asked for', () => {
    render(
      <GanttPanel
        plan={planOf({
          rows: [rowAt('strip', 0, 3), rowAt('sand', 4, 4)],
          slices: [
            sliceAt('strip-dev', 'strip', 0, 3, { personId: 'kat' }),
            sliceAt('sand-dev', 'sand', 4, 4, { estimated: false, personId: 'kat' }),
          ],
          personNames: new Map([['kat', 'Kat']]),
        })}
        startDate={MONDAY_START}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    // At rest: no bar, no tick, no label, and nothing carrying the hook the
    // browser gate finds an assumed bar by.
    expect(barFor('sand-dev')).toBeNull();
    expect(document.querySelector('[data-gantt-tick="sand-dev"]')).toBeNull();
    expect(document.querySelector('[data-gantt-bar-label="sand-dev"]')).toBeNull();
    expect(document.querySelectorAll('[data-assumed]')).toHaveLength(0);
    // One bar on a two-slice chart, counted rather than named: the count is
    // what moves to 2 the moment an uncosted slice is drawn.
    expect(document.querySelectorAll('[data-gantt-bar]')).toHaveLength(1);

    // And the estimated bar beside it is untouched — without this the five
    // assertions above would hold of a panel that drew no bars at all. Row 0's
    // bar is still on row 0: the unestimated row keeps its place, it just has
    // nothing on it.
    const real = drawnBox('[data-gantt-bar="strip-dev"]');
    expect(Math.floor(real.y)).toBe(0);
    expect(real.width).toBe(3);
    expect(document.querySelectorAll('[data-gantt-label]')).toHaveLength(2);

    askForTheDetail('[data-assumed]');

    // Asked for: the assumed bar is back, whole. The engine's own numbers say
    // this slice starts and finishes on workday 4 — a span of no days, which is
    // no bar at all — while the mark is drawn across the two workdays nobody
    // gave it, which off a Friday reaches over the weekend. That gap between
    // the numbers and the width is exactly what the dashes and the `?` say.
    const assumed = drawnBox('[data-gantt-bar="sand-dev"]');
    expect(assumed.width).toBe(4);
    expect(barFor('sand-dev')?.getAttribute('data-start')).toBe('4');
    expect(barFor('sand-dev')?.getAttribute('data-finish')).toBe('4');
    expect(Math.floor(assumed.y)).toBe(1);
    expect(barFor('sand-dev')?.getAttribute('data-assumed')).toBe('true');
    expect(barFor('sand-dev')?.getAttribute('class')).toContain('[fill-opacity:0.35]');
    expect(document.querySelector('[data-gantt-bar-label="sand-dev"]')?.textContent).toContain('?');
    // And it says so in words as well as in paint: the width is a guess, and
    // the sentence that says so is a line of its own rather than a word tucked
    // into the duration. `not estimated` stands where a length would be.
    expect(labelOf(markFor('sand-dev'))).toContain('Not estimated — drawn as 2 days');
    expect(labelOf(markFor('sand-dev'))).toContain('not estimated');
    expect(document.querySelectorAll('[data-gantt-bar]')).toHaveLength(2);
    // And the costed bar has not moved to make room, in either state: the
    // switch decides what is painted and nothing about where anything is.
    expect(drawnBox('[data-gantt-bar="strip-dev"]')).toEqual(real);
    expect(document.querySelectorAll('[data-gantt-label]')).toHaveLength(2);
  });

  itDom('draws the width it is given and says the numbers it was sent', () => {
    render(
      <GanttPanel
        plan={planOf({
          rows: [rowAt('sand', 3, 3), rowAt('trim', 3, 5)],
          slices: [
            sliceAt('sand-dev', 'sand', 3, 3, { estimated: false }),
            sliceAt('trim-dev', 'trim', 3, 5),
          ],
        })}
        startDate={MONDAY_START}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    // At rest the slice nobody estimated draws nothing, and the engine numbers
    // on the one that was are what be-01 said: `data-start` and `data-finish`
    // are the **workdays**, beside a width the calendar decided.
    expect(barFor('sand-dev')).toBeNull();
    expect(barFor('trim-dev')?.getAttribute('data-start')).toBe('3');
    expect(barFor('trim-dev')?.getAttribute('data-finish')).toBe('5');

    // And an estimated 3 → 5 stops at the Friday rather than running on to the
    // Monday its successor would start at: two days, no weekend tail.
    expect(barFor('trim-dev')?.getAttribute('x')).toBe('3');
    expect(barFor('trim-dev')?.getAttribute('width')).toBe('2');

    askForTheDetail('[data-assumed]');

    // With the detail on, the uncosted slice draws its assumed span and the
    // costed one is unmoved — the same four attributes, unchanged, which is
    // what says the switch paints rather than places.
    expect(barFor('sand-dev')?.getAttribute('data-assumed')).toBe('true');
    expect(barFor('trim-dev')?.getAttribute('data-start')).toBe('3');
    expect(barFor('trim-dev')?.getAttribute('data-finish')).toBe('5');
    expect(barFor('trim-dev')?.getAttribute('x')).toBe('3');
    expect(barFor('trim-dev')?.getAttribute('width')).toBe('2');
  });

  /**
   * A slice **estimated** at no days is drawn by a tick, because a
   * `<rect width="0">` paints nothing at all and the row would read as empty.
   * `expectedDays({0, 0, 0})` is 0, so this is a real answer — somebody costed
   * this work at nothing — and it is the one case that keeps the tick apart
   * from the unestimated slice beside it, which is now not drawn at all.
   */
  itDom('draws no hand-off line to a slice that is not drawn', () => {
    // Kat does `strip` and then `sand`, and nobody has costed `sand`. The
    // dashed line is drawn from one bar to another, so with `sand`'s bar gone
    // it would run to a point on an empty row — a mark pointing at nothing,
    // which is worse than no mark. `trim` is Kat's next estimated slice and
    // keeps its line, so this is not "no links are drawn any more".
    render(
      <GanttPanel
        plan={planOf({
          rows: [rowAt('strip', 0, 3), rowAt('sand', 3, 3), rowAt('trim', 3, 6)],
          slices: [
            sliceAt('strip-dev', 'strip', 0, 3, { personId: 'kat' }),
            sliceAt('sand-dev', 'sand', 3, 3, {
              estimated: false,
              personId: 'kat',
              boundBy: 'person',
              resourcePredecessorId: 'strip-dev',
            }),
            sliceAt('trim-dev', 'trim', 3, 6, {
              personId: 'kat',
              boundBy: 'person',
              resourcePredecessorId: 'strip-dev',
            }),
          ],
          personNames: new Map([['kat', 'Kat']]),
        })}
        startDate={MONDAY_START}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    expect(document.querySelector('[data-gantt-person-link="strip-dev->sand-dev"]')).toBeNull();
    // The one whose both ends are drawn is still drawn — without this the
    // assertion above would hold of a chart with no links at all.
    expect(document.querySelector('[data-gantt-person-link="strip-dev->trim-dev"]')).not.toBeNull();
    expect(document.querySelectorAll('[data-gantt-person-link]')).toHaveLength(1);

    askForTheDetail('[data-assumed]');

    // And once the far end is drawn, so is the line to it: the rule is about
    // what is on the chart rather than about how the slice was costed, which is
    // why the link list reads `drawnBars` and is not gated on the switch of its
    // own.
    expect(document.querySelector('[data-gantt-person-link="strip-dev->sand-dev"]')).not.toBeNull();
    expect(document.querySelectorAll('[data-gantt-person-link]')).toHaveLength(2);
  });

  itDom('draws a pool wait as its own line, apart from a person’s hand-off', () => {
    // Platform's slots are full until `strip` ends, and `sand` needs two of
    // them. Nobody is named on either: this is a wait a reader answers by
    // hiring or by reassigning, not by asking somebody to hurry — which is why
    // it must not be drawn as a hand-off.
    render(
      <GanttPanel
        plan={planOf({
          rows: [
            rowAt('strip', 0, 3, { team: { state: 'named', name: 'Platform' } }),
            rowAt('sand', 3, 5, { team: { state: 'named', name: 'Platform' }, maxParallel: 2 }),
          ],
          slices: [
            sliceAt('strip-dev', 'strip', 0, 3),
            sliceAt('sand-dev', 'sand', 3, 5, {
              boundBy: 'capacity',
              resourcePredecessorId: 'strip-dev',
              capacityPredecessorIds: ['strip-dev'],
              width: 2,
              effort: 4,
              duration: 2,
            }),
          ],
        })}
        startDate={null}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    // Row middles, the same arithmetic every other line on this chart is drawn
    // with: out of `strip`'s finish at 3 on row 0, into `sand`'s start at 3 on
    // row 1.
    expect(markAttribute('[data-gantt-capacity-link="strip-dev->sand-dev"]', 'd')).toBe(
      'M 3 0.5 L 3 1.5',
    );
    expect(document.querySelectorAll('[data-gantt-person-link]')).toHaveLength(0);
  });

  itDom(
    'marks a zero-day estimate with a tick, and an unestimated one with a bar or nothing',
    () => {
      render(
        <GanttPanel
          plan={planOf({
            rows: [rowAt('strip', 0, 3), rowAt('sand', 5, 5), rowAt('trim', 5, 5)],
            slices: [
              sliceAt('strip-dev', 'strip', 0, 3),
              sliceAt('sand-dev', 'sand', 5, 5, { duration: 0 }),
              sliceAt('trim-dev', 'trim', 5, 5, { estimated: false }),
            ],
          })}
          startDate={MONDAY_START}
          scheduleError={null}
          generation={0}
          heightPx={null}
          onPickRow={() => undefined}
          onPointRow={() => undefined}
          pointedRow={null}
        />,
      );

      // Workday 5 is the Monday past the weekend, seven calendar days in — and
      // the zero-day estimate keeps its zero width there rather than being drawn
      // backwards to the Friday's edge, which is what a finish reading of a span
      // of no days would give.
      //
      // Proof: the tick block's `filter((bar) => bar.drawnSpan === 0)` turned off
      // (`filter(() => false)`), so no tick is drawn at all. This test alone
      // failed, on `expected 'nothing on the chart at [data-gantt-t…' to be '7'`
      // — the zero-day bar still in the DOM as a rect of no width, painting
      // nothing. Re-watched 2026-08-09 in this shape.
      expect(markAttribute('[data-gantt-tick="sand-dev"]', 'x1')).toBe('7');
      expect(barFor('sand-dev')?.getAttribute('width')).toBe('0');
      expect(document.querySelector('[data-gantt-tick="strip-dev"]')).toBeNull();
      // The unestimated slice stands on the same workday and, at rest, draws
      // neither mark: no bar and no tick. Somebody costing this work at zero days
      // said something; nobody costing it at all said nothing.
      expect(barFor('trim-dev')).toBeNull();
      expect(document.querySelector('[data-gantt-tick="trim-dev"]')).toBeNull();

      askForTheDetail('[data-assumed]');

      // Asked for, the two answers are still not drawn the same way: the zero-day
      // estimate keeps its tick and its rect of no width, and the uncosted slice
      // gets a bar two workdays wide and **no** tick — `drawnSpan` and not
      // `duration` is what keeps them apart, because an assumed span is never 0.
      expect(markAttribute('[data-gantt-tick="sand-dev"]', 'x1')).toBe('7');
      expect(barFor('sand-dev')?.getAttribute('width')).toBe('0');
      expect(document.querySelector('[data-gantt-tick="trim-dev"]')).toBeNull();
      expect(drawnBox('[data-gantt-bar="trim-dev"]').width).toBeGreaterThan(0);
    },
  );

  itDom('says the priority where the work item carries one, and nothing where it does not', () => {
    // Two rows, one with a priority and one without, in one render — so the assertion is
    // that the line appears *and* that its absence is the other row's whole
    // answer, rather than two tests that could each be right about a different
    // build.
    render(
      <GanttPanel
        plan={planOf({
          rows: [rowAt('strip', 0, 3, { priority: 2 }), rowAt('sand', 0, 2)],
          slices: [sliceAt('strip-dev', 'strip', 0, 3), sliceAt('sand-dev', 'sand', 0, 2)],
        })}
        startDate={null}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    // The **band's** words, since `priority-bands`: a bare `Priority 2` on a
    // chart is a number nobody reading it can name, and the ladder that names it
    // rides in the same payload as the slice. The line is
    // `priorityBandStyleOf(...).words`, which is the one resolution the table's
    // cell, the cards and the export also read.
    expect(linesOf(surfaceOn('strip-dev'))).toContain('Critical — priority 2');
    // Not "Priority —" and not a blank line: having no priority is a state of its own,
    // and a bar with nothing to say about it says nothing.
    expect(linesOf(surfaceOn('sand-dev')).filter((line) => line.includes('Priority'))).toEqual([]);
  });

  itDom('caps a bar in its band’s colour, and leaves an unranked bar uncapped', () => {
    // The **third** channel on a bar, and the only one this mark had spare: `fill`
    // is already the assignee and `stroke` is the critical path, so overloading
    // either would have made two facts one colour and told the reader neither.
    //
    // A separate element rather than a property of the rect, because an absent cap
    // is an absent node and not a transparent one — which is what makes the second
    // assertion here a real absence.
    //
    // Proof: the cap block deleted, and this failed on `expected null to be
    // truthy` — a chart on which no priority is visible at all. Watched
    // 2026-08-14.
    render(
      <GanttPanel
        plan={planOf({
          rows: [
            rowAt('strip', 0, 3, { priority: 2 }),
            rowAt('sand', 1, 2, { priority: 90 }),
            rowAt('paint', 2, 2),
          ],
          slices: [
            sliceAt('strip-dev', 'strip', 0, 3),
            sliceAt('sand-dev', 'sand', 0, 2),
            sliceAt('paint-dev', 'paint', 0, 2),
          ],
        })}
        startDate={null}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    const capOn = (sliceId: string): SVGElement | null =>
      document.querySelector<SVGElement>(`[data-priority-cap="${sliceId}"]`);

    expect(capOn('strip-dev')?.getAttribute('data-priority-rank')).toBe('0');
    expect(capOn('sand-dev')?.getAttribute('data-priority-rank')).toBe('4');
    // Different bands, different paint — the whole of "displays differently".
    expect(capOn('strip-dev')?.getAttribute('fill')).not.toBe(
      capOn('sand-dev')?.getAttribute('fill'),
    );
    // And nothing at all for a bar whose row nobody has prioritised.
    expect(capOn('paint-dev')).toBeNull();
  });

  itDom('leaves the bar the hover, the focus and the name, and gives the cap none of them', () => {
    // The cap is paint. A second target in front of the control the bar is would
    // put a reader one pixel away from a surface that does not open.
    render(
      <GanttPanel
        plan={planOf({
          rows: [rowAt('strip', 0, 3, { priority: 2 })],
          slices: [sliceAt('strip-dev', 'strip', 0, 3)],
        })}
        startDate={null}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    const cap = document.querySelector<SVGElement>('[data-priority-cap="strip-dev"]');
    expect(cap?.getAttribute('pointer-events')).toBe('none');
    expect(cap?.getAttribute('role')).toBeNull();
    expect(cap?.getAttribute('aria-label')).toBeNull();
  });

  itDom('says everything it knows in a surface, in the order the spec sets', () => {
    render(
      <GanttPanel
        plan={planOf({
          rows: [
            rowAt('strip', 2, 5, {
              number: '3.2',
              name: 'API',
              team: { state: 'named', name: 'Platform' },
              trioByRole: new Map([['dev', { optimistic: 2, realistic: 3, pessimistic: 8 }]]),
              waitsFor: ['3.1 Design'],
            }),
          ],
          slices: [
            sliceAt('strip-dev', 'strip', 2, 5, {
              boundBy: 'predecessor',
              personId: 'kat',
              float: 2,
            }),
          ],
          personNames: new Map([['kat', 'Kat']]),
        })}
        startDate={null}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    const surface = surfaceOn('strip-dev');
    // One fact to a line, the binding floor near the end — the sentence the
    // panel was built to show — and what the row waits for after it.
    expect(linesOf(surface)).toEqual([
      '3.2 - API',
      'Dev · Kat',
      'Team Platform',
      'Workdays 2 → 5 · 3 days',
      '2/3/8',
      'Float 2 days',
      'Waits for a dependency’s first estimated role',
      'after 3.1 Design',
    ]);
    // The heading against `rowWords`' own output and not against the literal
    // above it: the surface opens on the same line the chart's label column and
    // the plan's Number column read, and a test written to a literal alone
    // would let the two drift apart while staying green.
    expect(linesOf(surface)[0]).toBe(rowWords('3.2', 'API'));
  });

  itDom('says how many people a compressed bar runs, and how long the work really is', () => {
    // Six days of work run by three people in two: the bar is two days wide and
    // the estimate says six, and without this line the two read as a
    // contradiction.
    render(
      <GanttPanel
        plan={planOf({
          rows: [
            rowAt('strip', 0, 2, { team: { state: 'named', name: 'Platform' }, maxParallel: 3 }),
          ],
          slices: [sliceAt('strip-dev', 'strip', 0, 2, { width: 3, effort: 6, duration: 2 })],
        })}
        startDate={null}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    expect(linesOf(surfaceOn('strip-dev'))).toContain('3 people in parallel — 6 days of work in 2');
  });

  itDom('says the team’s size is why a parallelism did not apply, at either width', () => {
    // `widthFor` is `min(maxParallel, slots)`, so a row asking for three from a
    // team of two runs at two and a row asking for three from a team of one
    // runs at one. The second is the case the chart said nothing about at all:
    // the compressed line does not print at width 1, so before this line the
    // only account of the clamp was in the export.
    render(
      <GanttPanel
        plan={planOf({
          rows: [
            rowAt('strip', 0, 3, { team: { state: 'named', name: 'Platform' }, maxParallel: 3 }),
            rowAt('sand', 0, 6, { team: { state: 'named', name: 'Platform' }, maxParallel: 3 }),
          ],
          slices: [
            sliceAt('strip-dev', 'strip', 0, 3, { width: 2, effort: 6, duration: 3 }),
            sliceAt('sand-dev', 'sand', 0, 6, { width: 1, effort: 6, duration: 6 }),
          ],
        })}
        startDate={null}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    // Beside the compressed line rather than instead of it: one is how long the
    // work is, the other is why it is not shorter still.
    expect(linesOf(surfaceOn('strip-dev'))).toContain(
      'The team may have 2 at work at once — 3 in parallel not applied',
    );
    expect(linesOf(surfaceOn('strip-dev'))).toContain('2 people in parallel — 6 days of work in 3');
    // The team of one: this is the whole of what the card says about
    // parallelism, and it used to say nothing.
    expect(linesOf(surfaceOn('sand-dev')).filter((line) => line.includes('parallel'))).toEqual([
      'The team may have 1 at work at once — 3 in parallel not applied',
    ]);
  });

  itDom('says nothing about a clamp where nothing was clamped', () => {
    // Three rows, three reasons for silence: the row that got what it asked
    // for, the row that never asked, and the row whose width came down for the
    // other reason — a named person, which the line above already explains.
    render(
      <GanttPanel
        plan={planOf({
          rows: [
            rowAt('strip', 0, 3, { team: { state: 'named', name: 'Platform' }, maxParallel: 2 }),
            rowAt('sand', 0, 3, { team: { state: 'named', name: 'Platform' } }),
            rowAt('trim', 0, 6, { team: { state: 'named', name: 'Platform' }, maxParallel: 3 }),
          ],
          slices: [
            sliceAt('strip-dev', 'strip', 0, 3, { width: 2, effort: 6, duration: 3 }),
            sliceAt('sand-dev', 'sand', 0, 3),
            sliceAt('trim-dev', 'trim', 0, 6, { personId: 'kat', width: 1, effort: 6 }),
          ],
          personNames: new Map([['kat', 'Kat']]),
        })}
        startDate={null}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    const clampLines = (sliceId: string): string[] =>
      linesOf(surfaceOn(sliceId)).filter((line) => line.includes('at work at once'));
    expect(clampLines('strip-dev')).toEqual([]);
    expect(clampLines('sand-dev')).toEqual([]);
    expect(clampLines('trim-dev')).toEqual([]);
    // And the named person's own line is still the one that prints, so the
    // silence above is this line taking the case rather than both going quiet.
    expect(linesOf(surfaceOn('trim-dev'))).toContain(
      'One person is named — 3 in parallel not applied',
    );
  });

  itDom('says a named person is why a parallelism did not apply', () => {
    // D3 on screen: one human cannot work beside themselves, so naming kat on a
    // `maxParallel: 3` item collapses it to width 1 — and the number somebody
    // typed did nothing, which is the fact this line exists to state.
    render(
      <GanttPanel
        plan={planOf({
          rows: [
            rowAt('strip', 0, 6, { team: { state: 'named', name: 'Platform' }, maxParallel: 3 }),
            rowAt('sand', 0, 3, { maxParallel: 1 }),
          ],
          slices: [
            sliceAt('strip-dev', 'strip', 0, 6, { personId: 'kat', width: 1, effort: 6 }),
            sliceAt('sand-dev', 'sand', 0, 3, { personId: 'kat', width: 1, effort: 3 }),
          ],
          personNames: new Map([['kat', 'Kat']]),
        })}
        startDate={null}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    expect(linesOf(surfaceOn('strip-dev'))).toContain(
      'One person is named — 3 in parallel not applied',
    );
    // And nothing at all on the row that asked for one at a time, which is
    // every row of every plan today: a line saying `1 in parallel` on all of
    // them is furniture, exactly as `Priority —` would be.
    expect(linesOf(surfaceOn('sand-dev')).filter((line) => line.includes('parallel'))).toEqual([]);
  });

  itDom('names the ancestor an inherited team came from', () => {
    // The row itself names no team; its dates were scheduled against one an
    // ancestor named. A bar saying `Team Platform` with no Platform on the row
    // leaves "why did this move when somebody edited a team's number"
    // unanswerable.
    render(
      <GanttPanel
        plan={planOf({
          rows: [
            rowAt('strip', 0, 3, {
              team: { state: 'inherited', name: 'Platform', fromRow: '010 Backend' },
            }),
          ],
          slices: [sliceAt('strip-dev', 'strip', 0, 3)],
        })}
        startDate={null}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    expect(linesOf(surfaceOn('strip-dev'))).toContain('Team Platform — inherited from 010 Backend');
  });

  itDom('says whose people a pool-held bar is waiting for', () => {
    render(
      <GanttPanel
        plan={planOf({
          rows: [
            rowAt('strip', 0, 3, { team: { state: 'named', name: 'Platform' } }),
            rowAt('sand', 3, 5, { team: { state: 'named', name: 'Platform' }, maxParallel: 2 }),
          ],
          slices: [
            sliceAt('strip-dev', 'strip', 0, 3),
            sliceAt('sand-dev', 'sand', 3, 5, {
              boundBy: 'capacity',
              resourcePredecessorId: 'strip-dev',
              capacityPredecessorIds: ['strip-dev'],
              width: 2,
              effort: 4,
              duration: 2,
            }),
          ],
        })}
        startDate={null}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    expect(linesOf(surfaceOn('sand-dev'))).toContain(
      'Waits for Platform to free 2 people — after strip (Dev)',
    );
  });

  itDom('says no float figure at all on a bar of the critical path', () => {
    render(
      <GanttPanel
        plan={planOf({
          rows: [rowAt('strip', 0, 3, { number: '010', name: 'Strip' })],
          slices: [sliceAt('strip-dev', 'strip', 0, 3, { critical: true, float: 0 })],
        })}
        startDate={null}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    const lines = linesOf(surfaceOn('strip-dev'));
    expect(lines).toContain('On the critical path — no float');
    expect(lines.filter((line) => line.startsWith('Float'))).toEqual([]);
  });

  itDom('leaves no line blank where a fact is missing', () => {
    // Every absence at once, on one chart: a slice under no role, nobody
    // assigned, no estimate for that role, and no team. Each says so in words —
    // the whole of the "nothing is blank" scenario, on a project holding no
    // roles at all.
    render(
      <GanttPanel
        plan={planOf({
          rows: [rowAt('strip', 0, 3, { number: '010', name: 'Strip' })],
          slices: [sliceAt('strip-dev', 'strip', 0, 3, { roleId: null })],
          roles: [],
        })}
        startDate={null}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    const lines = linesOf(surfaceOn('strip-dev'));
    expect(lines).toContain('No role · Unassigned');
    expect(lines).toContain('No team');
    expect(lines).toContain('No estimate for this role');
    // And nothing empty among them, which is the fact the three lines above
    // cannot state between them: a line rendered and blank passes all three.
    expect(lines.filter((line) => line.trim() === '')).toEqual([]);
    // The row waits for nothing, and that is the one absence with no words —
    // `after` with nothing after it is not a fact.
    expect(lines.filter((line) => line.startsWith('after'))).toEqual([]);
  });

  itDom('names a team the directory read does not hold, and still draws', () => {
    // The skew this state exists for: the label arrives with the tree and the
    // team names with their own request, so a team created between the two is
    // stale rather than lost.
    //
    // Proof: the `unresolved` arm of `teamWords` replaced by `return ''` — the
    // blank label this branch exists not to render. This test alone failed, on
    // `expected [ '010 - Strip', 'Dev · Unassigned', …(4) ] to include 'Team
    // not in this directory read'`, with an empty paragraph on the surface in
    // its place. Watched, 2026-08-09.
    render(
      <GanttPanel
        plan={planOf({
          rows: [
            rowAt('strip', 0, 3, {
              number: '010',
              name: 'Strip',
              team: { state: 'unresolved' },
            }),
          ],
          slices: [sliceAt('strip-dev', 'strip', 0, 3)],
        })}
        startDate={null}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    expect(linesOf(surfaceOn('strip-dev'))).toContain('Team not in this directory read');
    expect(document.querySelector('[data-gantt-chart]')).not.toBeNull();
  });

  itDom('says what kind of thing the work is, and where an inherited tag came from', () => {
    render(
      <GanttPanel
        plan={planOf({
          rows: [
            rowAt('strip', 0, 3, {
              number: '010',
              name: 'Strip',
              tags: { state: 'named', names: ['Compliance', 'Rework'] },
            }),
            rowAt('sand', 3, 5, {
              number: '020',
              name: 'Sand',
              tags: { state: 'inherited', names: ['Compliance'], fromRow: '000 Hull' },
            }),
          ],
          slices: [sliceAt('strip-dev', 'strip', 0, 3), sliceAt('sand-dev', 'sand', 3, 5)],
        })}
        startDate={null}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    // Both tags on one line, because they are one fact about the row — a line
    // per tag would read as a list of things happening to it.
    expect(linesOf(surfaceOn('strip-dev'))).toContain('Tags Compliance, Rework');
    // The ancestor named, for the team's reason and more strongly: the row this
    // bar sits on names no tag at all, so a bare `Tags Compliance` here is a
    // word with no source anywhere on screen.
    expect(linesOf(surfaceOn('sand-dev'))).toContain('Tags Compliance — inherited from 000 Hull');
  });

  itDom('says nothing at all about tags on a plan nobody has tagged', () => {
    // The asymmetry with `No team` one line up, on purpose: a team is the pool
    // the dates were computed against and its absence explains the schedule; a
    // tag decides nothing, so a `No tags` line on every bar of every plan is
    // furniture. See `tagWords`.
    render(
      <GanttPanel
        plan={planOf({
          rows: [rowAt('strip', 0, 3, { number: '010', name: 'Strip' })],
          slices: [sliceAt('strip-dev', 'strip', 0, 3)],
        })}
        startDate={null}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    const lines = linesOf(surfaceOn('strip-dev'));
    expect(lines.filter((line) => line.startsWith('Tags'))).toEqual([]);
    // And the team's absence still said, so the test above is about the tag
    // line rather than about a surface that has stopped printing absences.
    expect(lines).toContain('No team');
  });

  itDom('gives each role’s bar its own dates and its own trio', () => {
    // Two roles on one leaf, which is the whole of "a bar's facts are its own
    // slice's": the row spans 0 → 5 and neither bar says so.
    //
    // Proof: the two dates derived from the row's own span — `spanWords` fed
    // `row.schedule.earliestStart/earliestFinish` in place of the bar's start
    // and finish. This test alone failed, on `expected [ '010 - Deck', 'Dev ·
    // Unassigned', …(4) ] to include '10 Aug → 12 Aug · 3 days'` — both bars
    // reading `10 Aug → 14 Aug`, the work item's whole span on the QA slice
    // that never touched the Monday. Watched, 2026-08-09.
    render(
      <GanttPanel
        plan={planOf({
          rows: [
            rowAt('deck', 0, 5, {
              number: '010',
              name: 'Deck',
              trioByRole: new Map([
                ['dev', { optimistic: 2, realistic: 3, pessimistic: 8 }],
                ['qa', { optimistic: 1, realistic: 1, pessimistic: 1 }],
              ]),
            }),
          ],
          slices: [
            sliceAt('deck-dev', 'deck', 0, 3),
            sliceAt('deck-qa', 'deck', 3, 5, { roleId: 'qa' }),
          ],
          roles: [
            { id: 'dev', name: 'Dev' },
            { id: 'qa', name: 'QA' },
          ],
        })}
        startDate={MONDAY_START}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    // The Dev slice runs 0 → 3 off a Monday origin and the QA slice 3 → 5, so
    // the two bars name different days and the row's own 10 Aug → 14 Aug span
    // is on neither of them.
    expect(linesOf(surfaceOn('deck-dev'))).toContain('10 Aug → 12 Aug · 3 days');
    expect(linesOf(surfaceOn('deck-dev'))).toContain('2/3/8');
    fireEvent.blur(markFor('deck-dev'));
    const qa = linesOf(surfaceOn('deck-qa'));
    expect(qa).toContain('13 Aug → 14 Aug · 2 days');
    // The bar's own role's trio, never the row's first one.
    expect(qa).toContain('1/1/1');
    expect(qa).not.toContain('2/3/8');
  });

  itDom('says a fraction in prose to two places, and draws it whole', () => {
    render(
      <GanttPanel
        plan={planOf({
          rows: [rowAt('strip', 5, 8.666666666666666)],
          slices: [
            sliceAt('strip-dev', 'strip', 5, 8.666666666666666, {
              duration: 3.6666666666666665,
              critical: true,
            }),
          ],
        })}
        startDate={MONDAY_START}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    const bar = markFor('strip-dev');
    // The prose rounds and the drawing does not — the one place in this panel
    // where a schedule number is not carried verbatim. Read off the bar's own
    // `aria-label`, which is the same derivation the surface renders and the
    // one thing left naming the slice once the `<title>` has gone.
    expect(labelOf(bar)).toContain('3.67 days');
    expect(labelOf(bar)).toContain('On the critical path');
    // The fraction survives the scale: the bar starts at the Monday, seven
    // calendar days in, and is drawn the whole three-and-two-thirds of it
    // rather than the two places the sentence above prints.
    expect(bar.getAttribute('x')).toBe('7');
    expect(bar.getAttribute('width')).not.toBe('3.67');
    expect(Number(bar.getAttribute('width'))).toBeCloseTo(3.6666666666666665, 12);
  });

  itDom('draws every other mark the geometry placed, in the same calendar days', () => {
    render(
      <GanttPanel
        plan={everyMarkOnOneDay()}
        startDate={MONDAY_START}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );
    askForTheDetail();

    // Three marks no assertion about a bar can see, each of them a `map` in the
    // SVG that could be deleted whole without a bar moving. Where each of them
    // stands is `every mark on the chart lands on the calendar day its workday
    // is`; that they are drawn at all is here.
    //
    // Proof: the four blocks deleted one at a time, a run apiece. Each deletion
    // failed this test and only this test, and the sentence stood in for the
    // missing mark every time (vitest abbreviates the selector in its summary
    // line):
    //   arrow   — `expected 'nothing on the chart at [data-gantt-a…' to contain 'M 5 1.5'`
    //   link    — `expected 'nothing on the chart at [data-gantt-p…' to contain '[stroke-dasharray:4_3]'`
    //   flag    — `expected 'nothing on the chart at [data-gantt-n…' to match /^M 7 /`
    // Watched, 2026-08-09.
    expect(markAttribute('[data-gantt-arrow="strip->sand"]', 'd')).toContain('M 5 1.5');
    // Dashed and its own colour: a hand-off is not a dependency, and the two
    // are told apart by nothing but how they are drawn.
    expect(markAttribute('[data-gantt-person-link="strip-dev->sand-dev"]', 'class')).toContain(
      '[stroke-dasharray:4_3]',
    );
    // And in Kat's colour, the same one her two bars are painted: the line and
    // its ends are one queue rather than a third kind of edge.
    //
    // Proof: the link's `stroke` left off, so it fell back to the SVG's
    // `currentColor` like every other line. Failed on `expected 'nothing on the
    // chart at [data-gantt-p…' to be '#1f77b4'`. Watched, 2026-08-09.
    expect(markAttribute('[data-gantt-person-link="strip-dev->sand-dev"]', 'stroke')).toBe(
      PERSON_BAR_COLORS[0],
    );
    // The flag is drawn, on its own row, at the day the calendar puts it.
    //
    // Proof: the flag's `d` built from `flag.rowIndex` instead of its `x` —
    // the mark still drawn, on the right row, at the wrong day. Failed on
    // `expected 'M 2 2.03 L 7.285714285714286 2.09 L 7…' to match /^M 7 /`.
    // Watched, 2026-08-09.
    expect(markAttribute('[data-gantt-not-before="2"]', 'd')).toMatch(/^M 7 /);
  });

  itDom('draws nothing at all while the dependencies run in a circle', () => {
    render(
      <GanttPanel
        plan={planOf({
          rows: [rowAt('strip', 0, 3)],
          // be-01 sends none of these with a cycle. The fixture carries one
          // anyway, so this is the panel refusing to draw rather than an empty
          // payload drawing nothing.
          slices: [sliceAt('strip-dev', 'strip', 0, 3)],
        })}
        startDate={null}
        scheduleError="cycle"
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    expect(document.querySelectorAll('rect')).toHaveLength(0);
    expect(screen.getByRole('status').textContent).toContain('run in a circle');
  });
});

/**
 * The three marks a live Chrome could not see, asserted as shapes.
 *
 * All three were drawn, all three were gated, and all three were invisible on
 * screen: a 1px headless elbow that collapsed onto the successor's own left
 * edge whenever a dependency was tight, a not-before flag painted **under** the
 * bar it belongs to, and a hairline bracket that read as a scratch. Nothing in
 * this file could see any of it, because every one of them draws the mark — the
 * fault was where the mark was, and how heavy.
 *
 * So these assertions are about the **relations between points**, not about
 * path text: the head arrives left of the bar it points at, the caret's whole
 * box is above the bar's top edge, the bracket's ends fall from its line. The
 * pixels are `e2e/gantt.spec.ts`'s, and the two halves are named in each
 * `Proof:` below.
 */
describe('the marks that had to be seen', () => {
  /**
   * The points of a path's `d`, in the user space the chart is drawn in.
   *
   * @throws When the path is not there, or holds no point at all — either of
   * which would otherwise make every assertion below vacuously true of an empty
   * list.
   */
  function pointsOf(selector: string): { x: number; y: number }[] {
    const d = document.querySelector(selector)?.getAttribute('d');
    if (d === null || d === undefined) throw new Error(`nothing on the chart at ${selector}`);
    const points = [...d.matchAll(/[ML] (-?[\d.]+) (-?[\d.]+)/g)].map((match) => ({
      x: Number(match[1]),
      y: Number(match[2]),
    }));
    if (points.length === 0) throw new Error(`the path at ${selector} has no points: ${d}`);
    return points;
  }

  /** One number off a mark, as the browser will read it. */
  function attributeNumber(selector: string, attribute: string): number {
    const raw = document.querySelector(selector)?.getAttribute(attribute);
    if (raw === null || raw === undefined) {
      throw new Error(`nothing on the chart at ${selector} carries ${attribute}`);
    }
    return Number(raw);
  }

  /**
   * A parent over two leaves, the second of which starts the workday the first
   * finishes and is held there by a date of its own.
   *
   * The tight case on purpose: `sand` starts at 8 and `strip` finishes at 8, so
   * the arrow has no room, and `sand`'s not-before offset is 8 as well, so the
   * caret and the bar's left edge are the same x. Both are the commonest shape
   * in a real plan and both are the shape the old drawing lost.
   *
   * Every offset is past the plan's first weekend and none of them has one
   * inside it, which is what keeps the two bars **touching** on a calendar
   * while every coordinate below differs from its workday number: workday 8 is
   * Thursday 2026-08-20, ten calendar days in.
   */
  const touchingPlan = (): GanttPlan =>
    planOf({
      rows: [
        rowAt('hull', 5, 10, { leaf: false }),
        rowAt('strip', 5, 8, { depth: 1 }),
        rowAt('sand', 8, 10, { depth: 1, notBeforeOffset: 8 }),
      ],
      slices: [sliceAt('strip-dev', 'strip', 5, 8), sliceAt('sand-dev', 'sand', 8, 10)],
      dependencies: [{ predecessorId: 'strip', successorId: 'sand' }],
    });

  /** Where the two bars of {@link touchingPlan} meet, on the calendar. */
  const TOUCH_AT = 10;

  const drawTouchingPlan = (startDate: IsoDate = MONDAY_START): void => {
    render(
      <GanttPanel
        plan={touchingPlan()}
        startDate={startDate}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );
  };

  itDom('leaves the successor’s left edge alone when the two bars touch', () => {
    drawTouchingPlan();
    askForTheDetail();

    const route = pointsOf('[data-gantt-arrow="strip->sand"]');
    const last = route.at(-1);
    const beforeLast = route.at(-2);
    // Proof: `arrowRoute` given back its old three points — `M fromX, fromY L
    // toX, fromY L toX, toY`. With `toX === fromX` those collapse to a bare
    // vertical **on** the successor's left edge, at 1px, under the bar and
    // under a critical ring: the arrow this repository shipped and nobody could
    // see. This test alone failed, on `the arrow arrives from above the
    // successor’s left edge, not from outside it: expected 10 to be less than
    // 10`. Re-watched 2026-08-09 on the calendar.
    expect(last).toEqual({ x: TOUCH_AT, y: 2.5 });
    expect(
      beforeLast?.x ?? Number.NaN,
      'the arrow arrives from above the successor’s left edge, not from outside it',
    ).toBeLessThan(TOUCH_AT);
    // And it got there by stepping past the predecessor's right edge rather
    // than by running down the shared edge: something in the route is to the
    // right of the touching point.
    expect(Math.max(...route.map((point) => point.x))).toBeGreaterThan(TOUCH_AT);
    // And it is drawn heavily enough to be one of the marks rather than an
    // artefact of the gridlines it crosses. What 1.5 actually measures is
    // `e2e/gantt.spec.ts`'s to say; jsdom computes no style at all.
    //
    // Proof: `[stroke-width:1.5]` struck from the class, leaving the 1px
    // hairline. This test alone failed, `1 failed | 30 passed`, on `expected
    // 'stroke-foreground fill-none' to contain '[stroke-width:1.5]'`. Watched
    // 2026-08-09.
    expect(
      document.querySelector('[data-gantt-arrow="strip->sand"]')?.getAttribute('class'),
    ).toContain('[stroke-width:1.5]');
  });

  itDom('points a filled head at the successor’s start', () => {
    drawTouchingPlan();
    askForTheDetail();

    const head = pointsOf('[data-gantt-arrow-head="strip->sand"]');
    // Proof: the `<path data-gantt-arrow-head>` deleted from the SVG, which is
    // the whole of what "an arrow with no arrowhead" is. This test alone failed
    // — `1 failed | 30 passed` — on `Error: nothing on the chart at
    // [data-gantt-arrow-head="strip->sand"]`, thrown by `pointsOf` rather than
    // asserted as `undefined`, so the message names the mark. Watched
    // 2026-08-09.
    expect(head.at(0)).toEqual({ x: TOUCH_AT, y: 2.5 });
    // A triangle whose base is behind its point: both other corners are left of
    // the successor's edge, so the head sits in the approach and not on the bar.
    expect(head.slice(1).every((corner) => corner.x < TOUCH_AT)).toBe(true);
    expect(document.querySelector('[data-gantt-arrow-head]')?.getAttribute('class')).toContain(
      'fill-foreground',
    );
  });

  itDom('puts the not-before caret clear of the bar that starts on it', () => {
    drawTouchingPlan();

    // The bar's own top edge, read off the rect rather than recomputed: what is
    // being asserted is that the caret is above **this bar as drawn**, and a
    // constant repeated here could go on agreeing with a bar that moved.
    const barTop = attributeNumber('[data-gantt-bar="sand-dev"]', 'y');
    const caret = pointsOf('[data-gantt-not-before="2"]');
    // Proof: the caret's `d` put back where it was — `M offset,BAR_INSET L
    // offset+0.35,BAR_INSET L offset,ROW_MIDDLE Z`, a triangle hanging off the
    // bar's own top-left corner, drawn before the bars and therefore painted
    // over by this one. This test alone failed, `1 failed | 30 passed`, on `the
    // caret is not clear of the bar it belongs to: expected 2.18 to be less
    // than 2.18`. Watched 2026-08-09.
    expect(caret).toHaveLength(3);
    for (const corner of caret) {
      expect(corner.y, 'the caret is not clear of the bar it belongs to').toBeLessThan(barTop);
      expect(corner.y).toBeGreaterThan(2);
    }
    // And it stands at the calendar day the bar starts on, not somewhere near
    // it and not at the workday number 8 the date was stored as.
    expect(Math.min(...caret.map((corner) => corner.x))).toBe(TOUCH_AT);
    expect(attributeNumber('[data-gantt-bar="sand-dev"]', 'data-start')).toBe(8);
  });

  itDom('says which date the caret is holding the row at', () => {
    drawTouchingPlan();

    // The **date**, worked out from the workday the row was held at and never
    // from where the caret stands: the caret is at calendar day 10 and the day
    // it names is Thursday 2026-08-20, which is workday 8. A sentence read off
    // the coordinate would name 2026-08-24.
    //
    // Proof: the `<title>` child emptied on the caret. This test alone failed,
    // on `expected '' to be 'No earlier than 2026-08-20'` — a mark that says
    // where and never what. Watched 2026-08-09.
    expect(document.querySelector('[data-gantt-not-before="2"] title')?.textContent).toBe(
      'No earlier than 2026-08-20',
    );
  });

  itDom(
    'draws no not-before caret on a row that draws no bar until the detail is asked for',
    () => {
      // Three rows held at a start date, and at rest only one of them draws a
      // bar: a parent (which draws nothing of its own) and a leaf nobody
      // estimated (which draws nothing either) would each carry a caret floating
      // over an empty track, because `layOutGantt` collects the flag before it
      // asks whether the row is a leaf or whether any of its slices was costed.
      //
      // With the detail on, all three rows draw something for a caret to stand
      // over — a bracket on the parent, an assumed bar on the uncosted leaf — so
      // all three carets come back, which is the rule as it stood before
      // `gantt-declutter`.
      render(
        <GanttPanel
          plan={planOf({
            rows: [
              rowAt('hull', 5, 8, { leaf: false, notBeforeOffset: 5 }),
              rowAt('strip', 5, 8, { depth: 1, notBeforeOffset: 5 }),
              rowAt('sand', 6, 6, { depth: 1, notBeforeOffset: 6 }),
            ],
            slices: [
              sliceAt('strip-dev', 'strip', 5, 8),
              sliceAt('sand-dev', 'sand', 6, 6, { estimated: false }),
            ],
          })}
          startDate={MONDAY_START}
          scheduleError={null}
          generation={0}
          heightPx={null}
          onPickRow={() => undefined}
          onPointRow={() => undefined}
          pointedRow={null}
        />,
      );

      expect(document.querySelector('[data-gantt-not-before="0"]')).toBeNull();
      expect(document.querySelector('[data-gantt-not-before="2"]')).toBeNull();
      // Beside the two absences and on the same render: the caret that must
      // still be drawn. Without it the assertions above would hold of a panel
      // that had stopped drawing carets at all.
      expect(document.querySelector('[data-gantt-not-before="1"]')).not.toBeNull();
      expect(document.querySelectorAll('[data-gantt-not-before]')).toHaveLength(1);
      // And the rows are where they were: the caret went, the row did not.
      expect(document.querySelectorAll('[data-gantt-label]')).toHaveLength(3);
      expect(viewBoxOf(document.querySelector('[data-gantt-chart]')).height).toBe(3);

      askForTheDetail('[data-gantt-bracket]');

      // All three, and the two marks they now stand over. The parent's caret is
      // the one a filter written over `drawnBars` alone could never bring back:
      // its row draws a bracket and never a bar.
      expect(document.querySelectorAll('[data-gantt-not-before]')).toHaveLength(3);
      expect(document.querySelector('[data-gantt-not-before="0"]')).not.toBeNull();
      expect(document.querySelector('[data-gantt-not-before="2"]')).not.toBeNull();
      expect(document.querySelector('[data-gantt-bracket="hull"]')).not.toBeNull();
      expect(barFor('sand-dev')?.getAttribute('data-assumed')).toBe('true');
      // And still three rows, three units of user space: the switch draws, it
      // does not lay out.
      expect(document.querySelectorAll('[data-gantt-label]')).toHaveLength(3);
      expect(viewBoxOf(document.querySelector('[data-gantt-chart]')).height).toBe(3);
    },
  );

  itDom('leaves a zero-projection parent’s row empty until the detail is asked for', () => {
    // The branch's projection starts and finishes on one workday — a modeled
    // state the seeded plan is full of, and the state the ghost bar answers
    // with a tick rather than with a rect of no width, which paints nothing.
    // At rest neither mark is drawn; asked for, the tick is.
    //
    // `hull` carries the zero projection on its own row rather than through its
    // children, because that is how the geometry reads it: a parent's bracket
    // is be-01's projection taken whole, and `placeGantt` never adds up what is
    // underneath (`gantt-geometry.ts`). This fixture said 5 → 8 until
    // `declutter-one-button` and so was not the zero-span case its name claimed
    // — nothing could see that while the mark was not drawn at all.
    render(
      <GanttPanel
        plan={planOf({
          rows: [
            rowAt('hull', 5, 5, { leaf: false }),
            rowAt('strip', 5, 5, { depth: 1 }),
            rowAt('sand', 5, 8, { depth: 1 }),
          ],
          slices: [
            sliceAt('strip-dev', 'strip', 5, 5, { duration: 0 }),
            sliceAt('sand-dev', 'sand', 5, 8),
          ],
        })}
        startDate={MONDAY_START}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    expect(document.querySelectorAll('[data-gantt-bracket]')).toHaveLength(0);
    // Beside the absence and on the same render, the two facts an empty chart
    // would fail: the children are still drawn, and they are still on rows 1
    // and 2 — the parent's row is empty, not gone. Row alignment with the
    // table is what the browser gate measures.
    expect(
      Math.floor(
        Number(document.querySelector('[data-gantt-tick="strip-dev"]')?.getAttribute('y1')),
      ),
    ).toBe(1);
    expect(Math.floor(drawnBox('[data-gantt-bar="sand-dev"]').y)).toBe(2);
    expect(document.querySelectorAll('[data-gantt-label]')).toHaveLength(3);
    expect(viewBoxOf(document.querySelector('[data-gantt-chart]')).height).toBe(3);

    askForTheDetail('[data-gantt-bracket]');

    // Asked for: a tick and not a rect, because a rect of no width paints
    // nothing at all. Workday 5 of a Monday start is seven calendar days in,
    // and the tick spans the bar band rather than being a point.
    const mark = document.querySelector('[data-gantt-bracket="hull"]');
    if (mark === null) throw new Error('the zero-span parent left no mark at all');
    expect(mark.tagName).toBe('line');
    expect(mark.getAttribute('x1')).toBe('7');
    expect(mark.getAttribute('x2')).toBe('7');
    expect(Number(mark.getAttribute('y2')) - Number(mark.getAttribute('y1'))).toBeCloseTo(0.64, 12);
    // And the children have not moved to make room for it.
    expect(Math.floor(drawnBox('[data-gantt-bar="sand-dev"]').y)).toBe(2);
    expect(document.querySelectorAll('[data-gantt-label]')).toHaveLength(3);
    expect(viewBoxOf(document.querySelector('[data-gantt-chart]')).height).toBe(3);
  });

  itDom('draws no mark of its own on a parent’s row until the detail is asked for', () => {
    drawTouchingPlan();

    // At rest the ghost bar is gone whole — rect and tick both, so nothing is
    // left spanning the projection its children already draw.
    expect(document.querySelectorAll('[data-gantt-bracket]')).toHaveLength(0);
    // And nothing else moved to make room: both leaves are drawn, on their own
    // rows, at the calendar days they were at. An assertion about an absence
    // with no assertion about a presence beside it passes against a chart that
    // draws nothing at all.
    const strip = drawnBox('[data-gantt-bar="strip-dev"]');
    const sand = drawnBox('[data-gantt-bar="sand-dev"]');
    expect(Math.floor(strip.y)).toBe(1);
    expect(Math.floor(sand.y)).toBe(2);
    expect(sand.x).toBe(TOUCH_AT);
    // The parent's row is still a row: three labels, three units of user space.
    expect(document.querySelectorAll('[data-gantt-label]')).toHaveLength(3);
    expect(viewBoxOf(document.querySelector('[data-gantt-chart]')).height).toBe(3);

    askForTheDetail('[data-gantt-bracket]');

    // Asked for, the ghost is the leaf bar's own shape — same inset, same
    // height, both corner radii — in the page's ink at low opacity rather than
    // solid, so it reads as the projection of the rows beneath it rather than
    // as work of its own. Read off the two rects rather than written out, so
    // "the same bar as other bars" is the assertion and not a comment.
    const ghost = drawnBox('[data-gantt-bracket="hull"]');
    expect(ghost.y - Math.floor(ghost.y)).toBeCloseTo(strip.y - Math.floor(strip.y), 12);
    expect(ghost.height).toBe(strip.height);
    expect(Math.floor(ghost.y)).toBe(0);
    expect(document.querySelector('[data-gantt-bracket="hull"]')?.getAttribute('class')).toContain(
      'fill-foreground/15',
    );
    // The leaves are where they were, and so is every row.
    expect(drawnBox('[data-gantt-bar="strip-dev"]')).toEqual(strip);
    expect(drawnBox('[data-gantt-bar="sand-dev"]')).toEqual(sand);
    expect(document.querySelectorAll('[data-gantt-label]')).toHaveLength(3);
    expect(viewBoxOf(document.querySelector('[data-gantt-chart]')).height).toBe(3);
  });

  /**
   * A10's shape, which is where the routing fault was measured: `010` three
   * days, `020` two and `030` four both waiting on it, `040` two waiting on
   * both. `020` finishes before `030` does, so the arrow from `020` to `040`
   * has room for a plain elbow and used to turn down through the whole length
   * of `030`'s bar on the row between them.
   */
  const a10Plan = (): GanttPlan =>
    planOf({
      rows: [rowAt('010', 0, 3), rowAt('020', 3, 5), rowAt('030', 3, 7), rowAt('040', 7, 9)],
      slices: [
        sliceAt('010-dev', '010', 0, 3),
        sliceAt('020-dev', '020', 3, 5),
        sliceAt('030-dev', '030', 3, 7),
        sliceAt('040-dev', '040', 7, 9),
      ],
      dependencies: [
        { predecessorId: '010', successorId: '020' },
        { predecessorId: '010', successorId: '030' },
        { predecessorId: '020', successorId: '040' },
        { predecessorId: '030', successorId: '040' },
      ],
    });

  itDom('draws no arrow through a bar, off the marks it actually drew', () => {
    render(
      <GanttPanel
        plan={a10Plan()}
        startDate={MONDAY_START}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );
    // `askForTheDetail`, not `askForTheArrows`: this test arrived with #47
    // (`arrow-dodge`) and this branch renamed the helper and the button hook
    // under it. Git merged both sides without a conflict and the **product**
    // did not compile — `Cannot find name 'askForTheArrows'`, which fails
    // `typecheck` and stops the whole file running under vitest, killing the
    // one assertion #47's own review called the only one that can see the
    // panel handing the router the wrong bars, inset or approach. Every signal
    // in front of that merge was green: no conflict markers, `mergeStateStatus
    // CLEAN`, and a CI run against a base two hours stale. Reconciled on the
    // rebase, 2026-08-12; the cross-review note has the account.
    askForTheDetail();

    // Read off the document rather than off the geometry: this is the one
    // assertion that can see the panel handing the router the wrong bars, the
    // wrong inset or the wrong approach — `gantt-geometry.test.ts` proves the
    // routing itself, and would go on passing through all three.
    const bars = [...document.querySelectorAll('[data-gantt-bar]')].map((bar) => {
      const box = drawnBox(`[data-gantt-bar="${String(bar.getAttribute('data-gantt-bar'))}"]`);
      return {
        id: String(bar.getAttribute('data-gantt-bar')),
        left: box.x,
        right: box.x + box.width,
        top: box.y,
        bottom: box.y + box.height,
      };
    });
    expect(bars).toHaveLength(4);

    const crossings: string[] = [];
    for (const arrow of [...document.querySelectorAll('[data-gantt-arrow]')]) {
      const id = String(arrow.getAttribute('data-gantt-arrow'));
      const route = pointsOf(`[data-gantt-arrow="${id}"]`);
      for (const [index, corner] of route.entries()) {
        if (index === 0) continue;
        const from = route[index - 1];
        for (const bar of bars) {
          const spans = (low: number, high: number, one: number, other: number): boolean =>
            Math.min(one, other) < high && Math.max(one, other) > low;
          const inside =
            from.x === corner.x
              ? from.x > bar.left &&
                from.x < bar.right &&
                spans(bar.top, bar.bottom, from.y, corner.y)
              : from.y > bar.top &&
                from.y < bar.bottom &&
                spans(bar.left, bar.right, from.x, corner.x);
          if (inside) crossings.push(`${id} run ${String(index)} crosses ${bar.id}`);
        }
      }
    }

    // Proof: `arrowRoute` given back its pre-`arrow-dodge` body — the plain
    // elbow whenever `toX - fromX >= 2 * approach`, the jog otherwise, and no
    // reading of the bars at all. This test alone failed, on `expected [
    // '020->040 run 2 crosses 030-dev' ] to deeply equal []`. Watched
    // 2026-08-12.
    expect(crossings).toEqual([]);
    // Not a vacuous pass over an empty list: four arrows were read, and each
    // has at least the three runs an elbow is made of.
    expect(document.querySelectorAll('[data-gantt-arrow]')).toHaveLength(4);
    expect(pointsOf('[data-gantt-arrow="020->040"]').length).toBeGreaterThan(3);
  });
});

/**
 * The words on the chart, which are all of them HTML.
 *
 * Design §1: the SVG's user space is non-uniformly scaled, so a `<text>` in it
 * would be a stretched glyph. Every label is a span positioned by the same
 * `DAY_PX`/`ROW_PX` the SVG is sized by — which is the arithmetic these tests
 * recompute rather than write pixel numbers for.
 */
/**
 * The canvas holds every mark the chart draws.
 *
 * The marks are not all inside the engine's numbers, and two of them are
 * routinely outside: a dependency arrow steps clear of a bar before it turns,
 * so a successor at workday 0 routes through negative x, and the same arrow off
 * the last bar routes past the horizon. The viewBox used to be `0 0 horizon
 * rows`, and a browser's own `overflow: hidden` on an `<svg>` clipped both —
 * measured in Chromium at **0 painted pixels** for the head of a left-edge
 * arrow, while `getBoundingClientRect` went on reporting the box it would have
 * had. That is why the browser half of this lives in `e2e/gantt.spec.ts`: a
 * clipped path still measures.
 *
 * What jsdom can hold is the arithmetic — that every x the chart draws at is
 * inside the box it declares.
 */
describe('the canvas holds every mark it draws', () => {
  /**
   * A plan whose one arrow runs off **both** ends of the schedule.
   *
   * `sand` is unestimated, so it sits at workday 0 and the dependency from
   * `strip` — which finishes at the horizon — has to come back to it: the route
   * leaves past the last day and arrives from left of the first. The commonest
   * shape there is, since an unestimated row is where every plan starts.
   *
   * `strip` runs 0 → 6, so the schedule crosses a weekend and the canvas is
   * eight calendar days rather than six workdays: a fixture inside one week
   * would hold whether the canvas were the calendar's or the engine's.
   */
  const routeOffBothEnds = (): GanttPlan =>
    planOf({
      rows: [rowAt('strip', 0, 6), rowAt('sand', 0, 0, { notBeforeOffset: 6 })],
      slices: [
        sliceAt('strip-dev', 'strip', 0, 6),
        sliceAt('sand-dev', 'sand', 0, 0, { duration: 0, estimated: false }),
      ],
      dependencies: [{ predecessorId: 'strip', successorId: 'sand' }],
    });

  /**
   * Every x the chart draws at: the points of every path, and both edges of
   * every bar.
   *
   * @throws When the chart drew nothing, which would make a claim about "every
   * mark" a claim about none.
   */
  function everyDrawnX(): number[] {
    const drawn = [...document.querySelectorAll('[data-gantt-chart] path')].flatMap((mark) =>
      [...(mark.getAttribute('d') ?? '').matchAll(/[ML] (-?[\d.]+) (-?[\d.]+)/g)].map((point) =>
        Number(point[1]),
      ),
    );
    const bars = [...document.querySelectorAll('[data-gantt-bar]')].flatMap((bar) => {
      const x = Number(bar.getAttribute('x'));
      return [x, x + Number(bar.getAttribute('width'))];
    });
    const xs = [...drawn, ...bars];
    if (xs.length === 0) throw new Error('the chart drew no marks to measure');
    return xs;
  }

  itDom('declares a canvas wide enough for a route that leaves the schedule', () => {
    render(
      <GanttPanel
        plan={routeOffBothEnds()}
        startDate={MONDAY_START}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );
    // The routes are the whole fixture, and no route is drawn until they are
    // asked for.
    askForTheDetail();

    const xs = everyDrawnX();
    // The fixture really does route outside the schedule, at both ends. Without
    // these two the assertions below would hold of a chart nothing ever left,
    // which is the shape of check R5 exists to stop. Eight, because six
    // workdays over a weekend is eight calendar days — the number the canvas
    // has to reach past.
    expect(Math.min(...xs)).toBeLessThan(0);
    expect(Math.max(...xs)).toBeGreaterThan(8);

    // Proof: the viewBox put back to `0 0 horizon rowCount` and the width to
    // `horizon * DAY_PX`. This test alone failed, on `expected
    // -0.35714285714285715 to be greater than or equal to 0` — the arrow's
    // approach, a third of a day left of a canvas that started at 0, which is
    // where Chromium painted nothing at all. Watched 2026-08-09.
    const box = viewBoxOf(document.querySelector('[data-gantt-chart]'));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(box.minX);
    expect(Math.max(...xs)).toBeLessThanOrEqual(box.minX + box.width);
  });

  itDom('keeps the bars on the engine’s numbers while the canvas grows', () => {
    render(
      <GanttPanel
        plan={routeOffBothEnds()}
        startDate={MONDAY_START}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    // The canvas's edges are not the schedule's, and neither is the calendar:
    // `data-finish` is the engine's sixth **workday** while the bar is drawn
    // across eight calendar days, and a wider box moves neither.
    expect(barFor('strip-dev')?.getAttribute('x')).toBe('0');
    expect(barFor('strip-dev')?.getAttribute('width')).toBe('8');
    expect(barFor('strip-dev')?.getAttribute('data-finish')).toBe('6');
  });

  itDom('takes an open surface away with the bar the switch stops drawing', () => {
    // The effect that dismisses an orphaned surface has always claimed this
    // case — "its row was collapsed away, narrowed off by a search, or is
    // simply no longer drawn" — and before this switch it could not arise: the
    // drawn set only ever changed on a refetch, and a refetch bumps
    // `generation`, which clears both surfaces outright. Now the set changes
    // when somebody presses `Detail`, and a surface resolved against
    // `chart.bars` — every bar the plan has — would outlive its own rect,
    // anchored by its `AnchorRect` snapshot to coordinates on a row that is now
    // empty, reciting `not estimated` facts about a bar nobody can see.
    //
    // The focus opener rather than the pointer, and that is the case: both
    // self-healing paths need a real event the reachable version does not have.
    // A pointer must leave the rect to click the switch (`onPointerOut` →
    // dismiss) and keyboard focus blurs on the way to it (`onBlur` → dismiss);
    // what is left is a pointer resting on the bar while the switch is worked
    // from the keyboard, which is neither. jsdom's `fireEvent.focus` moves no
    // `activeElement`, so nothing here fires a blur either — which is what
    // makes it the right stand-in for that state. Cross-review, 2026-08-12.
    render(
      <GanttPanel
        plan={routeOffBothEnds()}
        startDate={MONDAY_START}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );
    askForTheDetail('[data-assumed]');

    // The ghost is on the chart and its surface is open on it.
    expect(barFor('sand-dev')?.getAttribute('data-assumed')).toBe('true');
    expect(linesOf(surfaceOn('sand-dev'))[0]).toContain('sand');

    // The switch off again — the same press, not a refetch, so `generation` is
    // untouched and the blanket clear it drives never runs.
    const toggle = document.querySelector('[data-gantt-detail-toggle]');
    if (!(toggle instanceof HTMLElement)) throw new Error('the detail switch is not on the panel');
    fireEvent.click(toggle);

    expect(barFor('sand-dev'), 'the ghost bar is still drawn').toBeNull();
    expect(noSurface(), 'the surface outlived the bar it belongs to').toBe(true);
  });

  itDom('declares the same canvas across the switch, on the axis that could move', () => {
    // **The width, which every other invariance assertion in this file leaves
    // alone.** The cross-state pairs compare `[data-gantt-label]` counts and
    // `viewBox` *height*, and height cannot move: the rows are the plan's. The
    // width can. It comes from `placed.horizon`, which reserves `bar.start +
    // bar.drawnSpan` for every **placed** bar whether or not that bar is drawn
    // — and the panel's own comment over `drawnBars` names the temptation
    // exactly, that "the narrowing is here and not in `layOutGantt`". Move the
    // filter into `placeGantt` and the canvas shrinks at rest by up to the two
    // workdays an assumed span is worth, while every assertion in this file
    // stays green. Cross-review, 2026-08-12.
    //
    // **Its own fixture, and the shape is the whole test.** `routeOffBothEnds`
    // holds an unestimated slice too and is no use here: its ghost is placed at
    // day 0, inside the estimated bar's own span, so a canvas sized off the
    // drawn set alone comes out the same width in both states and the equality
    // below passes against the very fault it is written for. Watched, on
    // h2puni, 2026-08-12 — the injection went green before this fixture
    // existed. What is needed is a ghost that reaches **past** every bar
    // somebody costed: `sand` starts where `strip` finishes and is drawn across
    // `ASSUMED_UNESTIMATED_WORKDAYS`, so it is the rightmost mark on the chart
    // whenever it is drawn at all.
    render(
      <GanttPanel
        plan={planOf({
          rows: [rowAt('strip', 0, 2), rowAt('sand', 2, 2)],
          slices: [
            sliceAt('strip-dev', 'strip', 0, 2),
            sliceAt('sand-dev', 'sand', 2, 2, { duration: 0, estimated: false }),
          ],
        })}
        startDate={null}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    // Non-vacuous, both halves: at rest the assumed bar really is off the
    // chart, so the two states really do draw different sets. Without this the
    // equality below would hold of a switch wired to a constant.
    expect(document.querySelectorAll('[data-assumed]')).toHaveLength(0);
    const atRest = viewBoxOf(document.querySelector('[data-gantt-chart]'));
    const costedRight = Number(barFor('strip-dev')?.getAttribute('x') ?? 0) + 2;

    askForTheDetail('[data-assumed]');

    const askedFor = viewBoxOf(document.querySelector('[data-gantt-chart]'));
    expect(document.querySelectorAll('[data-assumed]')).toHaveLength(1);
    // The precondition that makes the equality a claim: the ghost really does
    // reach past everything costed, so a canvas measured off the drawn marks
    // would have to be two workdays narrower at rest.
    const ghostRight =
      Number(barFor('sand-dev')?.getAttribute('x') ?? 0) +
      Number(barFor('sand-dev')?.getAttribute('width') ?? 0);
    expect(ghostRight, 'the ghost does not reach past the costed work').toBeGreaterThan(
      costedRight,
    );

    expect(askedFor.width, 'the canvas is a different width with the detail on').toBe(atRest.width);
    expect(askedFor.minX, 'the canvas starts at a different day with the detail on').toBe(
      atRest.minX,
    );
    // And the canvas already reserves the ghost's span at rest, which is the
    // positive form of the same claim: `placed.horizon` counts every *placed*
    // bar, drawn or not.
    expect(
      atRest.width,
      'the canvas at rest stops short of the ghost it is not drawing',
    ).toBeGreaterThanOrEqual(ghostRight);
  });
});

describe('the words on the bars are HTML over the chart', () => {
  /** The overlay label drawn on one slice's bar, or null where none is. */
  const labelOn = (sliceId: string): HTMLElement | null =>
    document.querySelector(`[data-gantt-bar-label="${sliceId}"]`);

  const oneAssignedBar = (parts: { start: number; finish: number; duration: number }): GanttPlan =>
    planOf({
      rows: [rowAt('trim', 0, 1), rowAt('strip', parts.start, parts.finish)],
      slices: [
        sliceAt('trim-dev', 'trim', 0, 1, { personId: 'ravi' }),
        sliceAt('strip-dev', 'strip', parts.start, parts.finish, {
          personId: 'kat',
          duration: parts.duration,
        }),
      ],
      personNames: new Map([
        ['ravi', 'Ravi'],
        ['kat', 'Kat'],
      ]),
    });

  itDom('puts the person’s name where the bar is, in pixels the chart’s own math gives', () => {
    render(
      <GanttPanel
        plan={oneAssignedBar({ start: 5, finish: 9, duration: 4 })}
        startDate={MONDAY_START}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    const label = labelOn('strip-dev');
    // Expected from the same two constants the SVG is sized by, never a pixel
    // number written out: a test holding `196px` would go on passing with the
    // day narrowed to 24. Seven and not five, because the span the label sits
    // over is the calendar's — the same conversion the rect under it made.
    //
    // Proof: `left: x * DAY_PX` replaced by `left: bar.rowIndex * DAY_PX` — a
    // label on the right row, one row's width from the left edge. This test
    // alone failed, on `expected '40px' to be '208px'`. Re-watched 2026-08-09.
    //
    // The band is in the number because the SVG under this span begins one band
    // left of day 0 (see {@link CHART_PAD_PX}); dropping it here puts every
    // name 12px left of the bar it belongs to.
    expect(label?.textContent).toBe('Kat · strip - strip');
    expect(label?.style.left).toBe(`${String(7 * DAY_PX + CHART_PAD_PX)}px`);
    expect(label?.style.width).toBe(`${String(4 * DAY_PX)}px`);
    // Second row, and the same inset the rect above it has: the words sit on
    // the bar rather than beside it.
    expect(label?.style.top).toBe(`${String(1 * ROW_PX + 0.18 * ROW_PX)}px`);
    // And those pixels are measured from the SVG's own box. `absolute` is
    // resolved against the nearest positioned ancestor, so a label whose
    // wrapper is not `relative` lands somewhere up the page — every number
    // above still correct and the label nowhere near its bar. jsdom lays
    // nothing out and cannot see that; it can see the arrangement that decides
    // it.
    //
    // Proof: `relative` dropped from the wrapper's class. This test alone
    // failed, on `expected false to be true`. Watched, 2026-08-09.
    const box = label?.parentElement;
    expect(box?.classList.contains('relative')).toBe(true);
    expect(box?.querySelector('[data-gantt-chart]')).not.toBeNull();
  });

  itDom('writes the team and how many of them on a bar nobody is named on', () => {
    render(
      <GanttPanel
        plan={planOf({
          rows: [
            rowAt('strip', 0, 6, { team: { state: 'named', name: 'Platform' }, maxParallel: 3 }),
            rowAt('sand', 0, 4),
          ],
          slices: [
            sliceAt('strip-dev', 'strip', 0, 6, { width: 3, effort: 18, duration: 6 }),
            sliceAt('sand-dev', 'sand', 0, 4),
          ],
        })}
        startDate={null}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    expect(labelOn('strip-dev')?.textContent).toBe('Platform ×3 · strip - strip');
    // And a bar with no team on it writes the row's words alone, exactly as it
    // did before this change: nothing to say about a pool it is not on.
    expect(labelOn('sand-dev')?.textContent).toBe('sand - sand');
  });

  itDom('keeps the person’s name on a bar somebody is named on, team or no team', () => {
    // One label, and the person is the more specific fact: `Platform ×1` over
    // kat's own bar would replace who is doing it with who it belongs to.
    render(
      <GanttPanel
        plan={planOf({
          rows: [rowAt('strip', 0, 4, { team: { state: 'named', name: 'Platform' } })],
          slices: [sliceAt('strip-dev', 'strip', 0, 4, { personId: 'kat' })],
          personNames: new Map([['kat', 'Kat']]),
        })}
        startDate={null}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    expect(labelOn('strip-dev')?.textContent).toBe('Kat · strip - strip');
  });

  itDom('writes nothing at all on a bar too narrow to hold a letter', () => {
    render(
      <GanttPanel
        plan={oneAssignedBar({ start: 3, finish: 3.2, duration: 0.2 })}
        startDate={null}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    // 0.2 of a workday is 5.6px, and the padding alone is 6 of them.
    //
    // Proof: the `if (shown === null) return null` guard in the overlay
    // replaced by rendering the span regardless. This test failed on `expected
    // <span …> to be null` — an empty label box sitting over a 5px bar, which
    // is a click target and a stray outline in a browser. Watched, 2026-08-09.
    expect(labelOn('strip-dev')).toBeNull();
    // The wide bar on the row above still has its words, so this is a threshold
    // and not a switch that turned every label off.
    expect(labelOn('trim-dev')?.textContent).toBe('Ravi · trim - trim');
  });

  itDom('writes the row’s own words after the assignee, and alone when nobody fits', () => {
    // The composition, taken directly: the assignee part the width already
    // decided, then ` · `, then the row words — which are never dropped for
    // room, because the label box crops them with an ellipsis instead.
    expect(barText('Kat', '010 - Strip', 4, DAY_PX)).toBe('Kat · 010 - Strip');
    expect(barText(null, '010 - Strip', 4, DAY_PX)).toBe('010 - Strip');
    // The one refusal: a bar without room for a single character.
    expect(barText(null, '010 - Strip', 0.2, DAY_PX)).toBeNull();
    expect(barText('Kat', '010 - Strip', 0.2, DAY_PX)).toBeNull();
  });

  itDom('carries the row words whole even where the box must crop them', () => {
    // One workday is 28px — room for four characters, nowhere near the words.
    // The DOM still holds the full string and the box crops it: a label
    // shortened by dropping the words would read as the assignee-only chart
    // this change removes.
    //
    // Proof: `barText` given the old appending rule — the words only when they
    // fully fit — `4 failed | 48 passed`: this test on `expected 'Kat' to be
    // 'Kat · strip - strip'`, and the three narrow-bar cases beside it, while
    // every wide bar stayed green. Watched 2026-08-09.
    render(
      <GanttPanel
        plan={oneAssignedBar({ start: 5, finish: 6, duration: 1 })}
        startDate={null}
        scheduleError={null}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );
    const label = labelOn('strip-dev');
    expect(label?.textContent).toBe('Kat · strip - strip');
    // Cropped by the box, in a size that sits inside the bar: the ellipsis
    // classes and the smaller font are what make the full string honest.
    expect(label?.classList.contains('text-ellipsis')).toBe(true);
    expect(label?.classList.contains('overflow-hidden')).toBe(true);
    expect(label?.classList.contains('text-[9px]')).toBe(true);
  });

  itDom('writes the row words on a bar nobody is on', () => {
    render(
      <GanttPanel
        plan={planOf({
          rows: [rowAt('strip', 0, 4)],
          slices: [sliceAt('strip-dev', 'strip', 0, 4)],
        })}
        startDate={null}
        scheduleError={null}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );
    // An unassigned bar used to write nothing at all — sixty grey bars with no
    // words was the fault. Now the row words stand alone.
    expect(labelOn('strip-dev')?.textContent).toBe('strip - strip');
  });

  itDom('writes the label in ink the bar it sits on can be read through', () => {
    // Nine people down the rows, so the ninth takes `#bcbd22` — the palette's
    // highlighter, the one entry white disappears into.
    const nine = Array.from({ length: 9 }, (_, at) => `person-${String(at)}`);
    render(
      <GanttPanel
        plan={planOf({
          rows: nine.map((_, at) => rowAt(`row-${String(at)}`, 0, 4)),
          slices: nine.map((personId, at) =>
            sliceAt(`slice-${String(at)}`, `row-${String(at)}`, 0, 4, { personId }),
          ),
          personNames: new Map(nine.map((personId) => [personId, `Person ${personId.slice(-1)}`])),
        })}
        startDate={null}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    // Proof: `color: inkOn(bar.personColor)` replaced by `color: '#ffffff'` —
    // the one white this whole function exists to avoid. This test alone
    // failed, on `expected 'rgb(255, 255, 255)' to be 'rgb(15, 23, 42)'`.
    // Watched, 2026-08-09.
    expect(labelOn('slice-8')?.style.color).toBe('rgb(15, 23, 42)');
    expect(labelOn('slice-0')?.style.color).toBe('rgb(255, 255, 255)');
  });

  itDom('shortens a name to initials before it clips, and never mid-word', () => {
    // The three answers of one measurement, taken directly: 4 workdays is
    // 112px and holds `Kat Bloom`; 1 workday is 28 and holds `KB`; a fifth of
    // one holds nothing.
    expect(barLabelFor('Kat Bloom', 4, DAY_PX)).toBe('Kat Bloom');
    expect(barLabelFor('Kat Bloom', 1, DAY_PX)).toBe('KB');
    expect(barLabelFor('Kat Bloom', 0.2, DAY_PX)).toBeNull();
    expect(barLabelFor(null, 4, DAY_PX)).toBeNull();
  });

  itDom('takes initials from the first and last names, and never doubles one', () => {
    expect(initialsOf('Kat Bloom')).toBe('KB');
    expect(initialsOf('Kat van der Bloom')).toBe('KB');
    expect(initialsOf('Kat')).toBe('K');
    expect(initialsOf('  ')).toBe('');
  });

  itDom('leaves the label out of the way of the click that takes the plan to a row', () => {
    render(
      <GanttPanel
        plan={oneAssignedBar({ start: 3, finish: 7, duration: 4 })}
        startDate={null}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    // A span over the middle of every bar would swallow the click the panel's
    // one interaction is made of. jsdom does no hit testing, so this is the
    // class that stops it rather than a dispatched click — the browser gate is
    // what can see the click land.
    expect(labelOn('strip-dev')?.classList.contains('pointer-events-none')).toBe(true);
  });
});

describe('the axis is a calendar', () => {
  const eightWorkdays = (startDate: IsoDate | null) =>
    render(
      <GanttPanel
        plan={planOf({
          rows: [rowAt('strip', 0, 8)],
          slices: [sliceAt('strip-dev', 'strip', 0, 8)],
        })}
        startDate={startDate}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

  itDom('puts the weekend on the axis, greyed, with the heavy line on the Monday', () => {
    eightWorkdays(MONDAY_START);

    // Cells 5 and 6 are the Saturday and the Sunday of the plan's first week,
    // and cell 7 is the Monday after them — which is where the week boundary
    // is, seven cells along rather than five.
    //
    // Proof: the heavy line put back on `offset % WEEK_DAYS === 0` — five
    // cells, which on a calendar is a Saturday. This test alone failed, on
    // `expected 'stroke-border/40' to be 'stroke-border'` at cell 7, the Monday
    // that then had no line on it. Watched 2026-08-09.
    expect(markAttribute('[data-axis-day="5"]', 'data-axis-date')).toBe('2026-08-15');
    expect(markAttribute('[data-axis-day="6"]', 'data-axis-date')).toBe('2026-08-16');
    expect(markAttribute('[data-axis-day="5"]', 'data-axis-weekend')).toBe('true');
    expect(markAttribute('[data-axis-day="6"]', 'data-axis-weekend')).toBe('true');
    expect(markAttribute('[data-axis-day="7"]', 'data-axis-date')).toBe('2026-08-17');
    expect(document.querySelector('[data-axis-day="7"][data-axis-weekend]')).toBeNull();

    expect(markAttribute('[data-gantt-gridline="7"]', 'class')).toBe('stroke-border');
    expect(markAttribute('[data-gantt-gridline="5"]', 'class')).toBe('stroke-border/40');
    expect(markAttribute('[data-gantt-gridline="6"]', 'class')).toBe('stroke-border/40');

    // And the weekend is a column of the chart rather than a label on the axis
    // — the whole point of the change, drawn where a reader sees it.
    //
    // Proof: the weekend `<rect>` block deleted from the SVG. This test alone
    // failed, on `expected 'nothing on the chart at [data-gantt-w…' to be
    // '1'` — an axis that says Saturday over a chart with no Saturday on it.
    // Watched 2026-08-09.
    expect(markAttribute('[data-gantt-weekend="5"]', 'width')).toBe('1');
    expect(markAttribute('[data-gantt-weekend="6"]', 'width')).toBe('1');
    expect(document.querySelector('[data-gantt-weekend="7"]')).toBeNull();
  });

  itDom('prints the workday offsets and no weekend at all without a start date', () => {
    eightWorkdays(null);

    // The axis this change did not touch: eight workdays, eight cells, no
    // calendar anywhere, and the heavy line every fifth one.
    //
    // Proof: the scale built unconditionally — `placeOnCalendar(chart,
    // startDate)` with a null start date, so `addWorkdays` was handed one.
    // This test alone failed, with the render itself throwing `Error: not a
    // calendar date: null` out of `render` rather than quietly drawing an
    // offset chart. Watched 2026-08-09.
    expect(document.querySelectorAll('[data-axis-day]')).toHaveLength(8);
    expect(document.querySelectorAll('[data-axis-date]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-axis-weekend]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-gantt-weekend]')).toHaveLength(0);
    // And a slice at workday 5 is drawn at 5, not at the 7 a calendar would
    // give it.
    expect(barFor('strip-dev')?.getAttribute('x')).toBe('0');
    expect(barFor('strip-dev')?.getAttribute('width')).toBe('8');

    // Five workdays is a working week and this axis holds no weekends, so the
    // boundary is arithmetic rather than a calendar question.
    //
    // Proof: the condition changed to `offset % 7 === 0` — a calendar week's
    // worth of days on an axis that holds none. This test alone failed, on
    // `expected 'stroke-border/40' to be 'stroke-border'` at day 5. Watched,
    // 2026-08-09.
    expect(markAttribute('[data-gantt-gridline="0"]', 'class')).toBe('stroke-border');
    expect(markAttribute('[data-gantt-gridline="5"]', 'class')).toBe('stroke-border');
    expect(markAttribute('[data-gantt-gridline="4"]', 'class')).toBe('stroke-border/40');
    expect(markAttribute('[data-gantt-gridline="6"]', 'class')).toBe('stroke-border/40');
  });

  itDom('bands every other row so a wide chart can be read across', () => {
    render(
      <GanttPanel
        plan={planOf({
          rows: [rowAt('strip', 0, 6), rowAt('sand', 0, 6), rowAt('trim', 0, 6)],
          slices: [
            sliceAt('strip-dev', 'strip', 0, 6),
            sliceAt('sand-dev', 'sand', 0, 6),
            sliceAt('trim-dev', 'trim', 0, 6),
          ],
        })}
        startDate={MONDAY_START}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    // Every other one, starting from the second: three rows make one band.
    //
    // Proof: the band block's `filter((label) => label.rowIndex % 2 === 1)`
    // turned off (`filter(() => false)`). This test alone failed, on `expected
    // [] to deeply equal [ '1' ]`. Watched, 2026-08-09.
    expect(
      [...document.querySelectorAll('[data-gantt-band]')].map((band) =>
        band.getAttribute('data-gantt-band'),
      ),
    ).toEqual(['1']);
    expect(markAttribute('[data-gantt-band="1"]', 'height')).toBe('1');
    // And a band reaches the whole calendar width rather than the six workdays
    // the engine counted, so the row it marks is readable to the last cell.
    expect(markAttribute('[data-gantt-band="1"]', 'width')).toBe('8');
  });
});

/** The Monday the fixture plan begins on, so every offset below is a weekday. */
const MONDAY = '2026-08-10';

const DEV: RoleView = { id: 'role-dev', name: 'Dev' };

const NO_DAYS: Days = { optimistic: 0, realistic: 0, pessimistic: 0 };

/**
 * One row of the fixture plan, with the schedule be-01 would have placed it at
 * and the dates be-01 would have printed from that schedule.
 *
 * The dates are written out rather than computed here on purpose: they are the
 * fixture's claim about what be-01 says, and the panel's own axis is what gets
 * compared to them. Two computations of the same rule would agree by
 * construction and prove nothing.
 */
function rowOf(parts: {
  id: string;
  number: string;
  name: string;
  parentId: string | null;
  start: number;
  finish: number;
  startsOn: string;
  endsOn: string;
  rolledUp?: boolean;
  /** A manual "no earlier than" date, as a calendar date the way be-01 stores it. */
  notBefore?: string;
}): WorkItemView {
  return {
    id: parts.id,
    parentId: parts.parentId,
    revision: 0,
    number: parts.number,
    name: parts.name,
    notes: '',
    frozenNumber: null,
    priority: null,
    maxParallel: 1,
    rolledUp: parts.rolledUp ?? false,
    estimates: parts.rolledUp === true ? {} : { [DEV.id]: NO_DAYS },
    dependsOn: [],
    finalDays: { [DEV.id]: parts.finish - parts.start },
    finalTotal: parts.finish - parts.start,
    dates: { startsOn: parts.startsOn, endsOn: parts.endsOn },
    startNoEarlierThan: parts.notBefore ?? null,
    startNoEarlierThanReason: null,
    serviceTeamId: null,
    teamIds: [],
    assignees: {},
    doesEveryPhase: null,
    schedule: {
      duration: parts.finish - parts.start,
      estimated: true,
      earliestStart: parts.start,
      earliestFinish: parts.finish,
      latestStart: parts.start,
      latestFinish: parts.finish,
      float: 0,
      critical: false,
    },
  };
}

/**
 * A plan of four rows on a calendar: a branch of two, and one row beside it.
 *
 * `Hull` spans its two children (0→5) and is the only parent, so it draws a
 * summary bracket and its children draw bars. `Rigging` reaches to 6, which is
 * what gives the axis a sixth workday for the ceil−1 negative to land on
 * instead of running off the end of it.
 */
const PLAN: WorkItemView[] = [
  rowOf({
    id: 'hull',
    number: '010',
    name: 'Hull',
    parentId: null,
    start: 0,
    finish: 5,
    startsOn: '2026-08-10',
    endsOn: '2026-08-14',
    rolledUp: true,
  }),
  rowOf({
    id: 'sanding',
    number: '011',
    name: 'Sanding',
    parentId: 'hull',
    start: 0,
    finish: 3,
    startsOn: '2026-08-10',
    endsOn: '2026-08-12',
  }),
  rowOf({
    id: 'sealing',
    number: '012',
    name: 'Sealing',
    parentId: 'hull',
    start: 3,
    finish: 5,
    startsOn: '2026-08-13',
    endsOn: '2026-08-14',
  }),
  rowOf({
    id: 'rigging',
    number: '020',
    name: 'Rigging',
    parentId: null,
    start: 3,
    finish: 6,
    startsOn: '2026-08-13',
    endsOn: '2026-08-17',
    // Five workdays after the Monday the plan starts, and seven calendar days:
    // the one date in the fixture that tells the two apart.
    notBefore: '2026-08-17',
  }),
];

/** One slice per leaf, which is what a one-phase plan gets from the engine. */
const sliceOf = (workItemId: string, start: number, finish: number): SliceView => ({
  id: `${workItemId}::${DEV.id}`,
  workItemId,
  roleId: DEV.id,
  personId: null,
  duration: finish - start,
  estimated: true,
  earliestStart: start,
  earliestFinish: finish,
  latestStart: start,
  latestFinish: finish,
  float: 0,
  critical: false,
  boundBy: 'projectStart',
  resourcePredecessorId: null,
  width: 1,
  effort: finish - start,
  capacityPredecessorIds: [],
});

const SLICES: SliceView[] = [
  sliceOf('sanding', 0, 3),
  sliceOf('sealing', 3, 5),
  sliceOf('rigging', 3, 6),
];

/**
 * {@link SLICES} as a chained schedule actually delivers them: whole workdays
 * arriving with drifted floating-point bits on either side.
 *
 * The rows and their printed dates stay {@link PLAN}'s on purpose — be-01
 * snaps the drift before it prints, so the fixture's claim about the Start and
 * End columns is the same clean day, and the chart has to land on it from the
 * drifted numbers alone.
 */
const DRIFTED_SLICES: SliceView[] = [
  sliceOf('sanding', 0, 3),
  sliceOf('sealing', 2.9999999999999996, 5.000000000000001),
  sliceOf('rigging', 3.0000000000000004, 6.000000000000001),
];

/**
 * What this fake was asked for and does not do.
 *
 * A throw rather than a silent `undefined`, for `plan-cards.test.tsx`'s reason:
 * a test that reached one of these would be exercising a path nothing here
 * models.
 */
const notImplemented = (what: string): never => {
  throw new Error(`the Gantt tests' fake project API has no ${what}`);
};

/**
 * The four reads `refresh` makes, disagreeing — which is what a peer's edit
 * landing between two of them leaves behind.
 *
 * `tree` carries the slices **and** the roles and names they were placed with;
 * `roles` and `listPeople` are separate requests at separate moments. This is
 * how a test says "these two moments do not agree" without inventing a
 * `GanttPlan` by hand: a hand-built plan proves the geometry throws, and the
 * question here is which of the four reads the panel is drawn from.
 */
interface ReadSkew {
  /** The slices `tree` answers with, when the fixture's own will not do. */
  slices?: SliceView[];
  /**
   * Stored dependencies to hang on the fixture's rows, by dependent id.
   *
   * A skew option rather than a field of {@link PLAN} so the chart every other
   * test in this file measures keeps drawing no arrows at all: an edge added to
   * the fixture is a mark added to twenty drawings that are not about it.
   */
  waits?: Record<string, string[]>;
  /** What the **separate** role read says, when it disagrees with the payload. */
  roles?: RoleView[];
  /** What the **separate** people read says, when it disagrees with the payload. */
  people?: PersonView[];
  /**
   * A team label to hang on the fixture's rows, by row id, and the directory
   * the separate read answers with.
   *
   * A skew option for {@link ReadSkew.waits}' reason: a label on the fixture is
   * a pool sentence added to twenty drawings that are not about it. A slice
   * floored by `capacity` on a row naming no team is a payload the geometry
   * refuses outright, so the two arrive together or not at all.
   */
  labels?: Record<string, string>;
  teams?: TeamView[];
}

/**
 * A read-only `ProjectApi` over {@link PLAN}.
 *
 * Read-only because nothing about the chart is an edit: these tests collapse a
 * branch, type in the Find box and click a bar, and every one of those is
 * answered from the tree that arrived. `plan-cards.test.tsx`'s fake writes, and
 * borrowing it would mean importing a file whose own tests would run again.
 */
function fakeApi(startDate: string | null, skew: ReadSkew = {}): ProjectApi {
  const people: PersonView[] = [{ id: 'kat', name: 'Kat', kind: 'person', teamIds: [] }];
  /** One label as be-01 sends it now: the column, and the join beside it. */
  const teamsOf = (serviceTeamId: string | null): string[] =>
    serviceTeamId === null ? [] : [serviceTeamId];
  const teams: TeamView[] = [];
  return {
    tree: () =>
      Promise.resolve({
        workItems: PLAN.map((row) => ({
          ...row,
          dates: startDate === null ? null : row.dates,
          dependsOn: skew.waits?.[row.id] ?? row.dependsOn,
          serviceTeamId: skew.labels?.[row.id] ?? row.serviceTeamId,
          // The set beside the column, because the table reads the set: a fake
          // tree that carried only the label would take every bar's team away.
          teamIds: teamsOf(skew.labels?.[row.id] ?? row.serviceTeamId),
        })),
        seq: 0,
        scheduleError: null,
        slices: skew.slices ?? SLICES,
        // The roles and the names the slices above were placed with — one
        // payload, which is the whole of the invariant the chart is drawn on.
        roles: [{ ...DEV }],
        assignedPeople: [{ id: 'kat', name: 'Kat' }],
        // Present and empty, never absent: be-01 always sends it, so a fake that
        // left it out would let `teamsOnThePlan` be handed `undefined` here and
        // never in production. A plan whose teams are unlimited is what `[]` says.
        teamCapacities: [],
        priorityBands: DEFAULT_PRIORITY_BANDS,
        estimateMethod: 'pert' as const,
        startDate,
        projectRevision: 0,
        undoable: false,
        redoable: false,
      }),
    // The **separate** read, which the skewed fixture below makes disagree with
    // the payload above on purpose.
    roles: () => Promise.resolve(skew.roles ?? [{ ...DEV }]),
    listTeams: () => Promise.resolve(skew.teams ?? teams),
    listTags: () => Promise.resolve([]),
    listServices: () => Promise.resolve([]),
    listPeople: () => Promise.resolve(skew.people ?? people),
    listProjects: () => notImplemented('listProjects'),
    createProject: () => notImplemented('createProject'),
    openProject: () => notImplemented('openProject'),
    renameProject: () => notImplemented('renameProject'),
    undo: () => notImplemented('undo'),
    redo: () => notImplemented('redo'),
    setEstimateMethod: () => notImplemented('setEstimateMethod'),
    setStartDate: () => notImplemented('setStartDate'),
    addRole: () => notImplemented('addRole'),
    renameRole: () => notImplemented('renameRole'),
    removeRole: () => notImplemented('removeRole'),
    addTeam: () => notImplemented('addTeam'),
    addPerson: () => notImplemented('addPerson'),
    create: () => notImplemented('create'),
    patch: () => notImplemented('patch'),
    setEstimate: () => notImplemented('setEstimate'),
    assign: () => notImplemented('assign'),
    move: () => notImplemented('move'),
    duplicate: () => notImplemented('duplicate'),
    remove: () => notImplemented('remove'),
    clearEstimate: () => notImplemented('clearEstimate'),
    freeze: () => notImplemented('freeze'),
    unfreezeProject: () => notImplemented('unfreezeProject'),
    unfreeze: () => notImplemented('unfreeze'),
    addDependency: () => notImplemented('addDependency'),
    removeDependency: () => notImplemented('removeDependency'),
  };
}

/** Puts the plan on screen and opens the chart under it. */
async function showTheChart(startDate: string | null = MONDAY, skew: ReadSkew = {}): Promise<void> {
  render(<WbsTable projectId="p1" api={fakeApi(startDate, skew)} />);
  await screen.findByText('Hull');
  fireEvent.click(screen.getByRole('button', { name: 'Gantt' }));
  await screen.findByLabelText('Gantt chart');
}

/** Every row the chart has drawn a label for, in the order it drew them. */
const labelsOnTheChart = (): string[] =>
  [...document.querySelectorAll('[data-gantt-label]')].map((label) => label.textContent);

/**
 * The calendar date the axis puts on one **workday**, or null where it prints
 * none.
 *
 * By `data-axis-workday` and not `data-axis-day`: a cell's own attribute is
 * where it stands on the calendar, and the workday it is, is the second thing
 * it carries. A bar's `data-start` is a workday, so this is the lookup that
 * joins the two — and a weekend cell answers for nobody, which is the point.
 */
const axisDateOn = (workday: string): string | null =>
  document.querySelector(`[data-axis-workday="${workday}"]`)?.getAttribute('data-axis-date') ??
  null;

/** The bar drawn for one work item's only slice. */
function barOn(workItemId: string): Element {
  const bar = document.querySelector(`[data-gantt-bar="${workItemId}::${DEV.id}"]`);
  // A missing bar is a broken fixture rather than a state to assert around: the
  // test that follows would report a click that landed nowhere.
  if (bar === null) throw new Error(`no bar on the chart for ${workItemId}`);
  return bar;
}

/**
 * What one of the table's schedule columns prints for the row at `at`.
 *
 * A throw rather than an empty string for a row that is not there: an empty
 * string would compare equal to an axis that printed nothing, and the whole
 * point of this comparison is that both sides said something.
 */
function columnText(columnId: string, at: number): string {
  const cell = [...document.querySelectorAll(`td[data-column="${columnId}"]`)].at(at);
  if (cell === undefined) throw new Error(`the table has no ${columnId} cell at row ${String(at)}`);
  return cell.textContent;
}

/**
 * The whole day one schedule column is showing a short date for.
 *
 * The columns print `13 Aug` since `T2 compact-columns`; the day in full is in
 * the cell's `title`, which is the form the axis under the chart is labelled
 * in and so the form the two can be compared in.
 *
 * @throws when the cell carries no `title` at all — a column printing workday
 * offsets has none, and comparing an axis date against nothing would be a
 * check that could not fail.
 */
function columnDay(columnId: string, at: number): string {
  const cell = [...document.querySelectorAll(`td[data-column="${columnId}"]`)].at(at);
  if (cell === undefined) throw new Error(`the table has no ${columnId} cell at row ${String(at)}`);
  const day = cell.querySelector('[title]')?.getAttribute('title');
  if (day === undefined || day === null) {
    throw new Error(`the ${columnId} cell at row ${String(at)} is not showing a date at all`);
  }
  // The End column says two things in one attribute — the day, and what its
  // `?` marker means — and only the day is comparable with an axis label.
  return day.split(' — ')[0] ?? day;
}

describe('the chart mirrors the plan', () => {
  itDom('leaves a collapsed branch’s children off the chart', async () => {
    await showTheChart();
    expect(labelsOnTheChart()).toEqual([
      '010 - Hull',
      '011 - Sanding',
      '012 - Sealing',
      '020 - Rigging',
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));

    // Proof: the panel fed `flat` — every row of the tree, which is what "the
    // full row list" means once the model's own expansion is out of the way.
    // Failed on `expected [ 'Hull', 'Sanding', 'Sealing', …(1) ] to deeply equal
    // [ 'Hull', 'Rigging' ]`: a chart drawing two rows the plan above it had
    // closed. Watched, 2026-08-09.
    //
    // `table.getRowModel().rows` is *not* the fault this one sees — that model
    // is already narrowed by the expansion, and this test passed under it while
    // the search test below failed. Both are here for that reason.
    expect(labelsOnTheChart()).toEqual(['010 - Hull', '020 - Rigging']);
  });

  itDom('draws exactly the rows a search narrowed the plan to', async () => {
    await showTheChart();

    fireEvent.change(screen.getByLabelText('Find'), { target: { value: 'S' } });

    // `Sanding` and `Sealing` match; `Hull` is kept because it places them.
    //
    // Proof: the panel fed `table.getRowModel().rows`, which no search narrows
    // — this failed on `expected [ 'Hull', 'Sanding', 'Sealing', …(1) ] to
    // deeply equal [ 'Hull', 'Sanding', 'Sealing' ]` while the collapse test
    // above went on passing. Watched, 2026-08-09.
    expect(labelsOnTheChart()).toEqual(['010 - Hull', '011 - Sanding', '012 - Sealing']);
  });

  itDom('takes the plan to a row when its bar is clicked', async () => {
    await showTheChart();

    fireEvent.click(barOn('sealing'));

    // Proof: `goToRow`'s lookup pointed at `not-before` — a column the table
    // has and the cards have not. **Three** tests failed on that one edit, in
    // two different ways, and the run said `3 failed | 10 passed`:
    //   this one and `takes the plan to a row when its label is clicked` on
    //     `expected <input type="date" …(6)></input> to be <textarea …(5)>
    //     </textarea>` — the caret in the wrong cell of the right row;
    //   `takes the plan to a row on the cards face too` on `expected <body
    //     style><div>…(1)</div></body> to be <textarea …(5)></textarea>` — the
    //     caret not moving at all, because `cellIn` found nothing to move it
    //     to.
    // The second message is the one only the cards face can produce, which is
    // why the click is proven on both faces rather than on the table alone.
    // Watched, 2026-08-09.
    expect(document.activeElement).toBe(screen.getByLabelText('Name of 012'));
  });

  itDom('takes the plan to a row when its label is clicked', async () => {
    await showTheChart();

    fireEvent.click(screen.getByRole('button', { name: '011 - Sanding' }));

    expect(document.activeElement).toBe(screen.getByLabelText('Name of 011'));
  });

  /**
   * The same click on the other renderer, and the reason it is a second test:
   * the cards draw three of the table's cells and none of its other columns
   * (`M mobile-cards`). A lookup that named one of the others lands the caret
   * in the wrong cell on the table and moves it nowhere at all here — two
   * failures the same edit produced, and only this test sees the second.
   * Watched, 2026-08-09; the messages are on the negative above.
   */
  itDom('takes the plan to a row on the cards face too', async () => {
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={fakeApi(MONDAY)} />);
    await screen.findByLabelText('Name of 010');
    fireEvent.click(screen.getByRole('button', { name: 'Plan actions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Gantt' }));
    await screen.findByLabelText('Gantt chart');

    fireEvent.click(barOn('sealing'));

    expect(document.activeElement).toBe(screen.getByLabelText('Name of 012'));
  });
});

/**
 * The axis and the Start/End columns are two readings of one schedule, and this
 * is the test that says they cannot disagree — string for string, be-01's
 * printed dates against the panel's own.
 */
describe('the label rail indents past the Number cap', () => {
  itDom('steps one level at every depth, uncapped', () => {
    // `hierarchyIndentFor` whole, not the Number cell's capped half: the rail
    // has no 93px column to protect, and a rail on the capped indent drew a
    // depth-5 row's label flush under its depth-4 parent's — the flattening
    // `deep-indent` removes. jsdom watches the arithmetic arrive on the
    // buttons; that padding really moves a label's text is a browser fact the
    // e2e deep-plan fixture measures.
    render(
      <GanttPanel
        plan={planOf({
          rows: [
            rowAt('root', 0, 1),
            rowAt('four', 0, 1, { depth: 4 }),
            rowAt('five', 0, 1, { depth: 5 }),
            rowAt('six', 0, 1, { depth: 6 }),
          ],
          slices: [sliceAt('root-dev', 'root', 0, 1)],
        })}
        startDate={MONDAY_START}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    const railPad = (id: string): string => {
      const label = document.querySelector<HTMLElement>(`[data-gantt-label="${id}"]`);
      if (label === null) throw new Error(`no label on the rail for ${id}`);
      return label.style.paddingLeft;
    };

    // Proof: the rail pointed back at the capped `numberIndentFor` — this
    // failed on `expected '56px' to be '68px'` at depth 5. Watched,
    // 2026-08-10.
    expect(railPad('root')).toBe('8px');
    expect(railPad('four')).toBe('56px');
    // Past `DEEPEST_INDENT`, where the capped indent held both at 56px.
    expect(railPad('five')).toBe('68px');
    expect(railPad('six')).toBe('80px');
  });
});

describe('the calendar axis agrees with the columns', () => {
  itDom('reads the same dates under a bar as the row’s Start and End cells', async () => {
    await showTheChart();

    // `Sealing`, the third row of the plan and the third of the chart: 3→5.
    const bar = barOn('sealing');

    // The axis cells the bar's own attributes point at, against the strings the
    // row's columns print — not two dates computed the same way twice.
    //
    // Proof: the ceil−1 nudge dropped, so a bar's last day is `ceil(finish)`.
    // This failed on `expected '2026-08-17' to be '2026-08-14'` — the axis
    // claiming a Monday for work the End column says finished on the Friday.
    // Watched, 2026-08-09.
    expect(axisDateOn(bar.getAttribute('data-start') ?? '')).toBe(columnDay('start', 2));
    expect(axisDateOn(bar.getAttribute('data-last-day') ?? '')).toBe(columnDay('finish', 2));
    // The same two days in the sentence the bar shows on hover, which is where
    // a reader meets the rule rather than in an attribute — printed by
    // `shortIsoDate`, which is the form the columns beside it print too.
    expect(labelOf(bar)).toContain('13 Aug → 14 Aug');
    // And it names neither of the two days a coordinate would give it. This
    // bar runs 3 → 5 and its right edge stops at calendar day 5 — Saturday
    // 2026-08-15, which nobody worked — while `addWorkdays(start, 5)` is
    // Monday 2026-08-17, the day its successor begins.
    //
    // Proof, **three faults, three runs**, each failing this test alone.
    // Watched 2026-08-09:
    //   `spanWords`' finish fed `addWorkdays(start, endOf(5))`, which names
    //     Monday 17 Aug — the day the successor begins;
    //   `spanWords`' finish fed `addCalendarDays(start, endOf(5))`, which names
    //     Saturday 15 Aug — the day the bar's right edge stands on and nobody
    //     worked;
    //   the dates derived from the row's own `dates` span instead of the bar's
    //     offsets, which is the same wrong answer wearing a third hat.
    expect(labelOf(bar)).not.toContain('17 Aug');
    expect(labelOf(bar)).not.toContain('15 Aug');
    // And the fixture's own claim about what be-01 printed, so a panel and a
    // table that agreed on the wrong dates would still be caught.
    expect(columnDay('start', 2)).toBe('2026-08-13');
    expect(columnDay('finish', 2)).toBe('2026-08-14');
    // And what the column actually shows, which is the short form of that same
    // day: the axis is labelled in full and the cell is not.
    expect(columnText('start', 2)).toBe('13 Aug');
  });

  itDom('holds a not-before flag at the calendar day its workday is', async () => {
    await showTheChart();

    // `Rigging` is the fourth row of the chart, and its stored date is
    // 2026-08-17: five workdays after the Monday the plan starts, and seven
    // calendar days. The chart is a calendar, so the flag stands at 7 — and it
    // stands **under the axis cell for that very date**, which is the assertion
    // that says the two agree rather than two numbers written out twice.
    //
    // The title of this test was once the opposite of the contract. On the
    // workday axis the flag stood at 5 and `notBeforeOffsetOf` counting
    // calendar days was the fault it guarded against; that guard is now the
    // second assertion below, which reads the date back off the workday the
    // offset is.
    expect(markAttribute('[data-gantt-not-before="3"]', 'd')).toMatch(/^M 7 /);
    expect(markAttribute('[data-axis-day="7"]', 'data-axis-date')).toBe('2026-08-17');
    // And the caret says the day that was typed, which is the offset's date and
    // never its coordinate's: calendar day 7 is 2026-08-17 here only because
    // the offset is 5, and `addWorkdays(start, 7)` would be 2026-08-19.
    expect(document.querySelector('[data-gantt-not-before="3"] title')?.textContent).toBe(
      'No earlier than 2026-08-17',
    );
  });

  itDom('prints workday offsets, and no dates at all, on a plan with no start date', async () => {
    await showTheChart(null);

    expect(document.querySelectorAll('[data-axis-date]')).toHaveLength(0);
    expect([...document.querySelectorAll('[data-axis-day]')].map((day) => day.textContent)).toEqual(
      ['0', '1', '2', '3', '4', '5'],
    );
  });

  itDom('reads a drifted schedule as the same days be-01 prints', async () => {
    // The engine's numbers, exactly as a chained schedule delivers them: whole
    // days wearing drifted bits. The columns print be-01's snapped dates, and
    // the chart must land on the same days from the drifted values alone — a
    // bare floor on `Sealing`'s 2.9999999999999996 starts its sentence a day
    // early (12 Aug), and a bare ceil on its 5.000000000000001 hands it a
    // fifth workday, whose date over the weekend is Monday 17 Aug.
    await showTheChart(MONDAY, { slices: DRIFTED_SLICES });

    const bar = barOn('sealing');
    expect(bar.getAttribute('data-last-day')).toBe('4');
    expect(axisDateOn('4')).toBe(columnDay('finish', 2));
    expect(labelOf(bar)).toContain('13 Aug → 14 Aug');
    expect(labelOf(bar)).not.toContain('12 Aug');
    expect(labelOf(bar)).not.toContain('17 Aug');
    // The fixture's own claim about what be-01 printed, so a chart and a
    // table agreeing on the wrong days would still be caught.
    expect(columnDay('start', 2)).toBe('2026-08-13');
    expect(columnDay('finish', 2)).toBe('2026-08-14');
    // And `Rigging`'s drifted 6.000000000000001 does not stretch the calendar:
    // the axis keeps the eight cells the clean plan draws, ending Monday
    // 2026-08-17.
    expect(document.querySelectorAll('[data-axis-day]')).toHaveLength(8);
    expect(markAttribute('[data-axis-day="7"]', 'data-axis-date')).toBe('2026-08-17');
  });

  itDom('does not mint an axis cell from a drifted horizon', async () => {
    // No start date, so the axis is the workday one and its horizon is the
    // engine's own numbers, drift included: `Rigging` reaches
    // 6.000000000000001, and a bare ceil drew a seventh cell no work can ever
    // stand in.
    await showTheChart(null, { slices: DRIFTED_SLICES });

    expect([...document.querySelectorAll('[data-axis-day]')].map((day) => day.textContent)).toEqual(
      ['0', '1', '2', '3', '4', '5'],
    );
  });
});

/**
 * {@link SLICES}, with the one fact `layOutGantt` refuses missing: `Sanding`'s
 * slice names a resource predecessor no slice in the payload has.
 *
 * The commonest way to hold such a payload is not a bug in be-01 at all — it is
 * a peer's edit landing between two of this client's four reads, which is the
 * skew {@link ReadSkew} is about. It throws, by design (`gantt-geometry.ts`),
 * and this fixture is what carries that throw onto the production render path.
 */
const SLICES_MISSING_A_PREDECESSOR: SliceView[] = SLICES.map((slice) =>
  slice.workItemId === 'sanding'
    ? { ...slice, boundBy: 'person' as const, resourcePredecessorId: 'a-slice-nobody-sent' }
    : slice,
);

/** What the boundary put on screen instead of a chart, or null while it did not. */
const faultWords = (): string | null =>
  document.querySelector('[data-gantt-fault]')?.textContent ?? null;

/**
 * {@link SLICES} with a sized, contended team holding one bar back — the plan
 * the deploy gate is armed against.
 *
 * `sealing` waits for `sanding`'s slot rather than for a dependency: `boundBy`
 * is `capacity`, the blocking set names the slice that had to end, and
 * `resourcePredecessorId` names the one an arrow is drawn from. This is exactly
 * what be-01 has been sending since `capacity-engine` (#48) for any plan whose
 * team is sized and contended, and what `capacity-write-paths` (#53) made
 * reachable in production by shipping the size write.
 */
const SLICES_HELD_BY_A_POOL: SliceView[] = SLICES.map((slice) =>
  slice.workItemId === 'sealing'
    ? {
        ...slice,
        boundBy: 'capacity' as const,
        resourcePredecessorId: `sanding::${DEV.id}`,
        capacityPredecessorIds: [`sanding::${DEV.id}`],
      }
    : slice,
);

/**
 * The whole read that plan arrives on: the slices, the label the pool is keyed
 * on, and the directory that names it.
 *
 * All three, because a `capacity` floor on a row naming no team is a payload
 * `gantt-geometry` refuses — the panel would rather throw than draw a sentence
 * about a pool it cannot name.
 */
const POOLED: ReadSkew = {
  slices: SLICES_HELD_BY_A_POOL,
  labels: { sealing: 'team-hull', sanding: 'team-hull' },
  teams: [{ id: 'team-hull', name: 'Hull crew' }],
};

describe('the deploy gate: a plan a sized team is holding back', () => {
  itDom('draws the chart rather than falling into the boundary', async () => {
    // **The watched red this whole change is gated on.** `floorWordsOf`'s
    // `default:` arm throws `GanttDataError` by design — a payload can carry a
    // sixth floor this build has never heard of — and `capacity` became that
    // sixth the day #48 merged. #53 then shipped the write that makes a sized
    // team reachable, so from that merge until this change every plan with a
    // sized, contended team renders an error boundary where its Gantt should
    // be. `capacity-engine/design.md`, "Batch sequencing", is where that was
    // called; `LLM_README.md` carries the landmine.
    //
    // Proof: the `case 'capacity':` arm struck from `floorWordsOf` so the
    // `default:` catches it again. Both tests here failed, on
    // `expected 'The chart cannot be drawn: slice seal…' to be null` and
    // `no bar on the chart for sealing`, against four uncaught
    // `GanttDataError: slice sealing::role-dev is held by capacity, which this
    // chart has no words for` — the whole chart replaced by the fallback on a
    // plan be-01 schedules every day. Watched 2026-08-13.
    await showTheChart(MONDAY, POOLED);

    expect(faultWords()).toBeNull();
    expect(document.querySelector('[data-gantt-chart]')).not.toBeNull();
    expect(barOn('sealing')).not.toBeNull();
  });

  itDom('says what is holding the bar, in the pool’s own words', async () => {
    // Drawing it is not enough: a bar held by a pool with a sentence about a
    // dependency on it is a chart that is confidently wrong about why the work
    // is late.
    await showTheChart(MONDAY, POOLED);

    fireEvent.focus(barOn('sealing'));
    const card = screen.getByRole('tooltip');
    expect(linesOf(card).join(' ')).toContain('Hull crew');
  });

  itDom('still draws when the directory read has not caught up with the pool', async () => {
    // The same plan, one read behind: the label rides the tree and the team
    // names ride the directory, so a team created between the two is
    // `unresolved` — the skew `ServiceTeamLabel` documents as normal, and which
    // the cards, the export and the table all degrade for.
    //
    // Proof: the `unresolved` arm of `poolNameOf` returning `null` again, so
    // the capacity arm's no-team throw catches it. This test alone failed, on
    // `expected 'The chart cannot be drawn: slice seal…' to be null` against
    // `GanttDataError: slice sealing::role-dev is floored by a team's capacity
    // but its row names no team` — the whole chart in the boundary for a state
    // that self-heals on the next read. Watched 2026-08-13.
    await showTheChart(MONDAY, { ...POOLED, teams: [] });

    expect(faultWords()).toBeNull();
    expect(barOn('sealing')).not.toBeNull();

    fireEvent.focus(barOn('sealing'));
    expect(linesOf(screen.getByRole('tooltip')).join(' ')).toContain(
      'a team this plan has not loaded',
    );
  });
});

describe('a chart that cannot be drawn', () => {
  itDom('says why, and leaves the plan alone', async () => {
    await showTheChart(MONDAY, { slices: SLICES_MISSING_A_PREDECESSOR });

    // 1. The chart is not there, and the reason on screen is the payload's own
    //    words — the slice, and what it promised. "Something went wrong" would
    //    throw away the only description anybody will ever have of a skew that
    //    is over by the time it is read.
    expect(document.querySelector('[data-gantt-chart]')).toBeNull();
    expect(faultWords()).toContain('The chart cannot be drawn');
    expect(faultWords()).toContain('a-slice-nobody-sent');
    expect(faultWords()).toContain('which is not a slice in this payload');

    // 2. And the editor is untouched, which is the whole reason the boundary
    //    wraps the panel alone: the plan is what the reader came for, the chart
    //    is the optional feature that may degrade (AGENTS.md, R5).
    //
    // Proof: `<GanttFaultBoundary>` struck from `wbs-table.tsx` and the panel
    // rendered bare. This test failed with the render itself throwing —
    // `GanttDataError: slice sanding::role-dev names resource predecessor
    // a-slice-nobody-sent, which is not a slice in this payload`, out of
    // `render` rather than as a failed expectation, taking the four rows and
    // every toolbar control with it. Watched 2026-08-09.
    expect(screen.getByLabelText('Name of 010')).toHaveValue('Hull');
    expect(screen.getAllByLabelText(/^Name of /)).toHaveLength(4);
  });

  itDom('leaves the drag handle standing, and dragging it still moves the boundary', async () => {
    // The handle is the shell's and stands outside the boundary: a reader who
    // shrank the chart to almost nothing and then hit a skew must still be
    // able to drag it back open.
    await showTheChart(MONDAY, { slices: SLICES_MISSING_A_PREDECESSOR });
    expect(faultWords()).toContain('The chart cannot be drawn');

    const handle = screen.getByRole('separator', { name: 'Resize the Gantt chart' });
    // jsdom has no pointer capture; the browser half is e2e/gantt.spec.ts's.
    // The events are hand-built for {@link axisPointer}'s reason: jsdom takes
    // neither `pointerId` nor `clientY` from an init dictionary.
    handle.setPointerCapture = () => undefined;
    const grabAt = (name: string, clientY: number): Event => {
      const grab = new Event(name, { bubbles: true, cancelable: true });
      Object.defineProperty(grab, 'pointerId', { value: 3 });
      Object.defineProperty(grab, 'clientY', { value: clientY });
      return grab;
    };
    fireEvent(handle, grabAt('pointerdown', 600));
    fireEvent(handle, grabAt('pointermove', 500));
    fireEvent(handle, grabAt('pointerup', 500));

    // 84 — the floor, which is what a drag counts from where jsdom lays
    // nothing out — plus the 100px of travel.
    expect(localStorage.getItem('wbs.ganttHeight.p1')).toBe('184');
  });

  itDom('draws the chart again when the next read is whole', async () => {
    // The skew is one object the fake reads on every call, so moving it here is
    // a peer's next edit arriving — which is what a transient skew is.
    const skew: ReadSkew = { slices: SLICES_MISSING_A_PREDECESSOR };
    let notify: () => void = () => {
      throw new Error('the table never subscribed');
    };
    const subscribe = (_projectId: string, handlers: SubscriptionHandlers) => {
      notify = handlers.onChange;
      return { seen: () => undefined, unsubscribe: () => undefined };
    };
    render(<WbsTable projectId="p1" api={fakeApi(MONDAY, skew)} subscribe={subscribe} />);
    await screen.findByText('Hull');
    fireEvent.click(screen.getByRole('button', { name: 'Gantt' }));
    await screen.findByLabelText('Gantt chart');
    expect(faultWords()).toContain('The chart cannot be drawn');

    skew.slices = SLICES;
    notify();

    // React never retries a boundary on its own: without the reset this stays
    // on the fallback for the life of the page, and the reader's only way back
    // to a chart is to reload.
    //
    // Proof: `getDerivedStateFromProps` deleted from `GanttFaultBoundary`. This
    // test alone failed — `1 failed | 34 skipped`, on `Error: no bar on the
    // chart for sanding` — with the fallback still up over a plan that had been
    // whole since the refetch. Watched 2026-08-09.
    await waitFor(() => {
      expect(barOn('sanding')).not.toBeNull();
    });
    expect(faultWords()).toBeNull();
  });
});

describe('the chart is drawn from one read', () => {
  itDom('draws under the roles the payload carried, not the pickers’ list', async () => {
    // A peer removed `Dev` and added `Ops` between this client's `tree` read and
    // its `roles` read: the separate read now lists a phase no slice is under,
    // and lists none of the phase every slice **is** under. That is the
    // four-request skew this fix exists for, and nothing about it is malformed —
    // both answers were true when they were given.
    await showTheChart(MONDAY, { roles: [{ id: 'role-ops', name: 'Ops' }] });

    // Proof: `ganttPlan`'s `roles` put back to the `roles` state — the separate
    // read. This test failed on `expected null not to be null`, with the
    // boundary reading `The chart cannot be drawn: slice sanding::role-dev is
    // under role role-dev, which this plan does not list.` Watched 2026-08-09.
    expect(document.querySelector('[data-gantt-chart]')).not.toBeNull();
    expect(faultWords()).toBeNull();
    expect(labelsOnTheChart()).toEqual([
      '010 - Hull',
      '011 - Sanding',
      '012 - Sealing',
      '020 - Rigging',
    ]);
    // The phase's name is read from the same list the bar was placed by, so a
    // chart drawn from the skewed read would either throw or say `Ops`.
    expect(labelOf(barOn('sanding'))).toContain('Dev');
  });

  itDom('names the people the payload carried, not the directory read', async () => {
    // The other half, and it has its own test because one edit cannot reach
    // both: `Kat` is on `Sanding` in the payload, and the directory read is a
    // moment before she was added to it.
    await showTheChart(MONDAY, {
      slices: SLICES.map((slice) =>
        slice.workItemId === 'sanding' ? { ...slice, personId: 'kat' } : slice,
      ),
      people: [],
    });

    // Proof: `ganttPlan`'s `personNames` put back to the `people` state. This
    // test alone failed, on `expected 'The chart cannot be drawn: slice sand…'
    // to be null` — the boundary reading `slice sanding::role-dev is assigned
    // to kat, whom this plan does not name`. Watched 2026-08-09.
    expect(faultWords()).toBeNull();
    expect(labelOf(barOn('sanding'))).toContain('Kat');
    // And she is painted as somebody rather than as nobody, which is the other
    // thing the name decides.
    expect(barOn('sanding').getAttribute('fill')).toBe(PERSON_BAR_COLORS[0]);
  });
});

/**
 * The caption over the row labels names the month the reader is looking at,
 * which is only the starting month until the chart is scrolled. jsdom does no
 * layout, but a scroll event's `scrollLeft` is plain state — the arithmetic
 * from it to a workday index is what these hold.
 */
describe('the caption follows the scroll', () => {
  const augustIntoSeptember = () =>
    render(
      <GanttPanel
        plan={planOf({
          rows: [rowAt('strip', 0, 10)],
          slices: [sliceAt('strip-dev', 'strip', 0, 10)],
        })}
        startDate="2026-08-24"
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

  itDom('opens naming the month it starts in, the way a person says it', () => {
    augustIntoSeptember();
    // `Aug 2026` and never `2026-08`: the corner is the one place the chart
    // names a month, and it names it as a month.
    //
    // Proof: `monthWords` short-circuited to `date.slice(0, 7)` — the old
    // caption. `3 failed | 49 passed`: this test and the scroll test on
    // `Unable to find an element with the text: Aug 2026` / `Sep 2026`, and
    // the fixed-table case with them. Watched 2026-08-09.
    expect(screen.getByText('Aug 2026')).toBeDefined();
  });

  itDom('names the month that is on screen, not the one it started in', () => {
    augustIntoSeptember();
    const panel = document.querySelector('[data-gantt-panel]');
    if (!(panel instanceof HTMLElement)) throw new Error('the panel is not on the page');
    // The axis is a calendar now, so the cell that names September is the
    // eighth: 2026-08-24 plus eight calendar days is 2026-09-01, where plus
    // eight **workdays** would be 2026-09-03. Its cell begins at 8 × DAY_PX
    // past the pad, so anything past that names September.
    //
    // Proof: the caption pinned back to `axis[0]` — this test failed on
    // `Unable to find an element with the text: 2026-09` while the opening
    // test above stayed green. Watched, 2026-08-09.
    panel.scrollLeft = 8 * DAY_PX + CHART_PAD_PX;
    fireEvent.scroll(panel);
    expect(screen.getByText('Sep 2026')).toBeDefined();
    expect(screen.queryByText('Aug 2026')).toBeNull();
  });

  itDom('says a month the way a person does, from a fixed table', () => {
    expect(monthWords('2026-08-17')).toBe('Aug 2026');
    expect(monthWords('2026-12-01')).toBe('Dec 2026');
    expect(monthWords('2027-01-31')).toBe('Jan 2027');
  });

  itDom('refuses a month no calendar has, out loud', () => {
    // The production caller only ever hands this validated dates, so the unit
    // boundary is where the guard can be seen at all. Without it the table
    // indexes past its end and the caption reads `undefined 2026` — a corner
    // quietly printing nonsense instead of a fault reaching the boundary.
    //
    // Proof: the range guard deleted, so the lookup ran unchecked. This test
    // alone failed, on `expected [Function] to throw an error` — the fault
    // came back as the string 'undefined 2026'. Watched 2026-08-09.
    expect(() => monthWords('2026-13-01')).toThrow('names a month no calendar has');
    expect(() => monthWords('not a date')).toThrow('names a month no calendar has');
  });
});

/**
 * A plan holding one of each family the detail switch gates, beside the marks
 * it does not touch.
 *
 * `hull` is a parent, so its row has a bracket to draw. `sand` waits on `strip`
 * and shares Kat with it, so there is a stored dependency and a hand-off.
 * `polish` is Kat's next slice and nobody has costed it, so there is an assumed
 * bar and a hand-off **onto** it. Both `hull` and `polish` are held at a start
 * date and draw nothing at rest, which is the pair of carets the switch decides
 * about; `sand` is held at one and draws a bar, so its caret is the one that
 * stands either way.
 *
 * Separate from {@link everyMarkOnOneDay} rather than a fifth row on it: four
 * tests measure that fixture's coordinates and its row count, and this one is
 * about how many of each mark there are.
 */
const everyGatedMark = (): GanttPlan =>
  planOf({
    rows: [
      rowAt('hull', 0, 9, { leaf: false, notBeforeOffset: 0 }),
      rowAt('strip', 0, 5, { depth: 1 }),
      rowAt('sand', 5, 7, { depth: 1, notBeforeOffset: 5 }),
      rowAt('polish', 7, 7, { depth: 1, notBeforeOffset: 7 }),
    ],
    slices: [
      sliceAt('strip-dev', 'strip', 0, 5, { personId: 'kat' }),
      sliceAt('sand-dev', 'sand', 5, 7, {
        personId: 'kat',
        boundBy: 'person',
        resourcePredecessorId: 'strip-dev',
      }),
      sliceAt('polish-dev', 'polish', 7, 7, {
        estimated: false,
        personId: 'kat',
        boundBy: 'person',
        resourcePredecessorId: 'sand-dev',
      }),
    ],
    dependencies: [{ predecessorId: 'strip', successorId: 'sand' }],
    personNames: new Map([['kat', 'Kat']]),
  });

describe('the detail switch', () => {
  const drawEveryMark = () =>
    render(
      <GanttPanel
        plan={everyGatedMark()}
        startDate={MONDAY_START}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

  const countOf = (selector: string): number => document.querySelectorAll(selector).length;

  /** The switch itself, or a throw naming a panel that has not got one. */
  function theSwitch(): HTMLElement {
    const toggle = document.querySelector('[data-gantt-detail-toggle]');
    if (!(toggle instanceof HTMLElement)) throw new Error('the detail switch is not on the panel');
    return toggle;
  }

  itDom('opens with none of the three families, and draws all of them when asked', () => {
    drawEveryMark();
    const toggle = theSwitch();

    // Off on open, and the switch says so. This is the whole change: sixty
    // elbows and forty ghosts bury the bars they stand among, so nobody gets
    // any of them until they ask — and it is **one** answer over all three,
    // which is what Dany asked for on 2026-08-12.
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(countOf('[data-gantt-arrow]')).toBe(0);
    expect(countOf('[data-gantt-arrow-head]')).toBe(0);
    expect(countOf('[data-gantt-bracket]')).toBe(0);
    expect(countOf('[data-assumed]')).toBe(0);
    // Beside the absences, on the same render: the marks the switch does not
    // touch. An absence assertion alone passes against a panel that drew
    // nothing at all.
    expect(countOf('[data-gantt-bar]')).toBe(2);
    expect(countOf('[data-gantt-person-link]')).toBe(1);
    expect(countOf('[data-gantt-not-before]')).toBe(1);
    expect(countOf('[data-gantt-label]')).toBe(4);

    fireEvent.click(toggle);

    // All three families arrive on one press. Both marks of the stored
    // dependency together — the elbow and the head are two paths of one mark,
    // and a condition on one of them leaves a floating triangle pointing at
    // nothing — the parent's bracket, and the uncosted slice's assumed bar with
    // the hand-off onto it and the two carets that now have something to stand
    // over.
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(countOf('[data-gantt-arrow]')).toBe(1);
    expect(countOf('[data-gantt-arrow-head]')).toBe(1);
    expect(countOf('[data-gantt-bracket]')).toBe(1);
    expect(countOf('[data-assumed]')).toBe(1);
    expect(countOf('[data-gantt-bar]')).toBe(3);
    expect(countOf('[data-gantt-person-link]')).toBe(2);
    expect(countOf('[data-gantt-not-before]')).toBe(3);
    // And the chart is the same shape: four rows, four labels, whichever way
    // the switch is set.
    expect(countOf('[data-gantt-label]')).toBe(4);

    fireEvent.click(toggle);
    expect(countOf('[data-gantt-arrow]')).toBe(0);
    expect(countOf('[data-gantt-arrow-head]')).toBe(0);
    expect(countOf('[data-gantt-bracket]')).toBe(0);
    expect(countOf('[data-assumed]')).toBe(0);
    expect(countOf('[data-gantt-bar]')).toBe(2);
    expect(countOf('[data-gantt-not-before]')).toBe(1);
  });

  itDom('opens with the detail a fresh panel is remounted onto', () => {
    drawEveryMark();
    fireEvent.click(theSwitch());
    expect(countOf('[data-gantt-arrow]')).toBe(1);

    // A remount and not a rerender: the fault boundary throws this panel away
    // and builds another on the next whole read, and a preference held in a
    // hook alone goes with it. The stored answer is what survives that.
    cleanup();
    drawEveryMark();

    expect(theSwitch().getAttribute('aria-pressed')).toBe('true');
    expect(countOf('[data-gantt-arrow]')).toBe(1);
    expect(countOf('[data-gantt-arrow-head]')).toBe(1);
    expect(countOf('[data-gantt-bracket]')).toBe(1);
    expect(countOf('[data-assumed]')).toBe(1);
    expect(localStorage.getItem('wbs.ganttDetail')).toBe('true');
  });

  itDom('refuses a stored answer that is not a boolean, and drops the key', () => {
    // The stored value is a claim, not a fact: hand-edited storage read at a
    // boundary. `"yes"` is a string a person would write and JSON parses
    // happily, which is why the check is on the type rather than on the parse.
    //
    // Proof: the `typeof claimed !== 'boolean'` refusal replaced by a truthy
    // read, so a claim that merely looked like one was taken as the answer.
    // `2 failed | 89 passed`: this test on `expected 'true' to be 'false'` —
    // the detail drawn from the string `"yes"` — and `refuses storage that is
    // not JSON at all` on `expected '{not json' to be null`. Watched
    // 2026-08-12.
    localStorage.setItem('wbs.ganttDetail', JSON.stringify('yes'));
    drawEveryMark();

    expect(theSwitch().getAttribute('aria-pressed')).toBe('false');
    expect(countOf('[data-gantt-arrow]')).toBe(0);
    expect(countOf('[data-gantt-bracket]')).toBe(0);
    expect(localStorage.getItem('wbs.ganttDetail')).toBeNull();
  });

  itDom('refuses storage that is not JSON at all, and drops the key', () => {
    localStorage.setItem('wbs.ganttDetail', '{not json');
    drawEveryMark();

    expect(theSwitch().getAttribute('aria-pressed')).toBe('false');
    expect(countOf('[data-gantt-arrow]')).toBe(0);
    expect(countOf('[data-gantt-bracket]')).toBe(0);
    expect(localStorage.getItem('wbs.ganttDetail')).toBeNull();
  });

  itDom('drops the key the arrows switch wrote, without reading it', () => {
    // `wbs.ganttArrows` answered a narrower question for one day, between
    // `gantt-declutter` and this change. Its `true` is **not** carried across:
    // a reader who asked for sixty elbows did not ask for the parent bars and
    // the uncosted ones as well, and opening their next chart with all three on
    // is the clutter they were promised the end of. So the answer is discarded
    // and the key is removed rather than left to accumulate.
    localStorage.setItem('wbs.ganttArrows', JSON.stringify(true));
    drawEveryMark();

    expect(theSwitch().getAttribute('aria-pressed')).toBe('false');
    expect(countOf('[data-gantt-arrow]')).toBe(0);
    expect(countOf('[data-gantt-bracket]')).toBe(0);
    expect(localStorage.getItem('wbs.ganttArrows')).toBeNull();
    // And it does not overwrite an answer this switch has already been given:
    // the retired key goes, the live one is read, and the chart opens on what
    // the reader last said with the control they actually pressed.
    cleanup();
    localStorage.setItem('wbs.ganttArrows', JSON.stringify(false));
    localStorage.setItem('wbs.ganttDetail', JSON.stringify(true));
    drawEveryMark();

    expect(theSwitch().getAttribute('aria-pressed')).toBe('true');
    expect(countOf('[data-gantt-arrow]')).toBe(1);
    expect(localStorage.getItem('wbs.ganttArrows')).toBeNull();
  });
});

/**
 * A plan whose predecessor is hidden and whose dependent is not — the two ways
 * a row leaves the screen while a bar still has to name it.
 *
 * `Rigging` is a root and `Sanding` is inside `Hull`, so collapsing `Hull` and
 * searching for `Rigging` each take the predecessor off the chart and leave the
 * dependent on it.
 */
const RIGGING_WAITS_FOR_SANDING: ReadSkew = { waits: { rigging: ['sanding'] } };

describe('a bar names what its row waits for, from the whole tree', () => {
  itDom('names a predecessor inside a collapsed branch', async () => {
    await showTheChart(MONDAY, RIGGING_WAITS_FOR_SANDING);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(labelsOnTheChart()).toEqual(['010 - Hull', '020 - Rigging']);

    // Proof: `namedInTheTree` built from `shownRows` instead of `flat` — this
    // test failed on `expected [ '020 - Rigging', 'Dev · Unassigned', …(5) ] to
    // include 'after 011 Sanding'`, the bar reading `after work that is not
    // shown` about a row the plan holds and the reader has merely closed. The
    // search test below failed on the same edit; both watched, 2026-08-09.
    expect(linesOf(surfaceOn('rigging::role-dev'))).toContain('after 011 Sanding');
  });

  itDom('names a predecessor a search narrowed away', async () => {
    await showTheChart(MONDAY, RIGGING_WAITS_FOR_SANDING);
    fireEvent.change(screen.getByLabelText('Find'), { target: { value: 'Rigging' } });
    expect(labelsOnTheChart()).toEqual(['020 - Rigging']);

    // The second half of the same fault, and it has its own test because a
    // collapse and a search narrow the plan by two different mechanisms.
    expect(linesOf(surfaceOn('rigging::role-dev'))).toContain('after 011 Sanding');
  });
});

describe('a bar is named and operable without a mouse', () => {
  /** Two bars on two rows, drawn straight rather than through the table. */
  const twoBars = (): GanttPlan =>
    planOf({
      rows: [
        rowAt('strip', 0, 3, { number: '010', name: 'Strip' }),
        rowAt('sand', 3, 5, { number: '020', name: 'Sand' }),
      ],
      slices: [sliceAt('strip-dev', 'strip', 0, 3), sliceAt('sand-dev', 'sand', 3, 5)],
    });

  const drawTwoBars = (picked: (rowId: string) => void = () => undefined): void => {
    render(
      <GanttPanel
        plan={twoBars()}
        startDate={MONDAY_START}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={picked}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );
  };

  itDom('carries its facts as an accessible name, and no <title> at all', () => {
    drawTwoBars();

    const bars = [...document.querySelectorAll('[data-gantt-bar]')];
    expect(bars).toHaveLength(2);
    for (const bar of bars) {
      // Proof, twice, watched 2026-08-09. The `aria-label` deleted from the
      // rect: this failed on `expected null to be a string`, which is a bar
      // with no name at all once the tooltip has gone — the fault the label had
      // to arrive **before** the `<title>` left. And a `<title>` restored as a
      // child of the rect: this failed on `expected <title /> to be null`, two
      // tooltips on one mark.
      expect(typeof bar.getAttribute('aria-label')).toBe('string');
      expect(bar.querySelector('title')).toBeNull();
    }
    expect(labelOf(bars[0])).toContain('010 - Strip');
    // The one `<title>` this change leaves alone lives on the caret, and this
    // plan holds none — so no bar on this chart carries one at all.
    expect(document.querySelector('[data-gantt-bar] title')).toBeNull();
  });

  itDom('shows a bar’s surface on focus and takes it away on blur', () => {
    drawTwoBars();

    fireEvent.focus(markFor('strip-dev'));
    expect(linesOf(screen.getByRole('tooltip'))[0]).toBe('010 - Strip');

    fireEvent.blur(markFor('strip-dev'));
    expect(noSurface()).toBe(true);
  });

  itDom('takes the plan to the row on Enter and on Space, and eats the key', () => {
    const picked: string[] = [];
    drawTwoBars((rowId) => picked.push(rowId));

    // `fireEvent` answers `false` for an event whose default was prevented,
    // which is the only thing jsdom can say about `preventDefault` — it
    // performs no default action of its own. That Space really does not scroll
    // the panel is a browser fact and is asserted in `e2e/gantt.spec.ts`; this
    // is the half that says the call is made at all.
    expect(fireEvent.keyDown(markFor('sand-dev'), { key: 'Enter' })).toBe(false);
    expect(fireEvent.keyDown(markFor('sand-dev'), { key: ' ' })).toBe(false);
    expect(picked).toEqual(['sand', 'sand']);
  });

  itDom('leaves every other key to the page', () => {
    const picked: string[] = [];
    drawTwoBars((rowId) => picked.push(rowId));

    // Proof: the `key` guard removed so every keydown picked the row — this
    // failed on `expected [ 'sand' ] to deeply equal []` and on `expected false
    // to be true`, a bar that swallowed Tab and took the reader off the chart
    // with it. Watched, 2026-08-09.
    expect(fireEvent.keyDown(markFor('sand-dev'), { key: 'Tab' })).toBe(true);
    expect(picked).toEqual([]);
  });
});

describe('one surface at a time, and it goes when its facts do', () => {
  const twoBarPlan = (numbers: [string, string]): GanttPlan =>
    planOf({
      rows: [
        rowAt('strip', 0, 3, { number: numbers[0], name: 'Strip' }),
        rowAt('sand', 3, 5, { number: numbers[1], name: 'Sand' }),
      ],
      slices: [sliceAt('strip-dev', 'strip', 0, 3), sliceAt('sand-dev', 'sand', 3, 5)],
    });

  const oneBarPlan = (): GanttPlan =>
    planOf({
      rows: [rowAt('strip', 0, 3, { number: '010', name: 'Strip' })],
      slices: [sliceAt('strip-dev', 'strip', 0, 3)],
    });

  const draw = (plan: GanttPlan, generation: number) => (
    <GanttPanel
      plan={plan}
      startDate={MONDAY_START}
      scheduleError={null}
      generation={generation}
      heightPx={null}
      onPickRow={() => undefined}
      onPointRow={() => undefined}
      pointedRow={null}
    />
  );

  /**
   * A pointer event of one kind or the other, built by hand.
   *
   * jsdom has no `PointerEvent`, so `fireEvent.pointerOver(node, { pointerType
   * })` constructs a plain `Event` and the init's `pointerType` is dropped on
   * the floor — the guard then reads `undefined`, refuses, and every assertion
   * about the pointer path passes because nothing ever opened. Watched:
   * `opens one surface, and only the last mark's` could not find a tooltip at
   * all. The property is defined on the event itself instead.
   */
  const pointerEvent = (kind: 'mouse' | 'touch', name: 'pointerover' | 'pointerout'): Event => {
    const event = new Event(name, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'pointerType', { value: kind });
    return event;
  };

  /** A pointer resting on a mark, which is what the delay is measured from. */
  const restOn = (sliceId: string): void => {
    fireEvent(markFor(sliceId), pointerEvent('mouse', 'pointerover'));
  };

  itDom('opens nothing for a pointer that crosses the chart', () => {
    vi.useFakeTimers();
    try {
      render(draw(twoBarPlan(['010', '020']), 0));

      restOn('strip-dev');
      fireEvent(markFor('strip-dev'), pointerEvent('mouse', 'pointerout'));
      act(() => {
        vi.advanceTimersByTime(1000);
      });

      // Proof: the `clearTimeout` in `cancelOpening` removed, so a departure
      // cancelled nothing — this failed on `expected false to be true`, a
      // surface opening a fifth of a second after the pointer had gone.
      // Watched, 2026-08-09.
      expect(noSurface()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  itDom('opens one surface, and only the last mark’s', () => {
    vi.useFakeTimers();
    try {
      render(draw(twoBarPlan(['010', '020']), 0));

      restOn('strip-dev');
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(linesOf(screen.getByRole('tooltip'))[0]).toBe('010 - Strip');

      restOn('sand-dev');
      act(() => {
        vi.advanceTimersByTime(1000);
      });

      // One tooltip on the page, and it is the second bar's: `getByRole`
      // throws where two match, which is what makes this the one-at-a-time
      // assertion rather than two about the second bar.
      expect(linesOf(screen.getByRole('tooltip'))[0]).toBe('020 - Sand');
    } finally {
      vi.useRealTimers();
    }
  });

  itDom('opens nothing at all for a pointer that is not a mouse', () => {
    // The guard, not its consequence: Chromium synthesizes a whole mouse
    // sequence from a tap and jsdom synthesizes nothing, so what this can see
    // is that a `touch` pointer opens no surface. That the **synthesized**
    // events do not open one either is a browser fact, and it is asserted at
    // 390×844 with `hasTouch` in `e2e/gantt.spec.ts`.
    vi.useFakeTimers();
    try {
      render(draw(twoBarPlan(['010', '020']), 0));

      fireEvent(markFor('strip-dev'), pointerEvent('touch', 'pointerover'));
      act(() => {
        vi.advanceTimersByTime(1000);
      });

      expect(noSurface()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  itDom('closes when the bar it was opened on is no longer drawn', () => {
    const { rerender } = render(draw(twoBarPlan(['010', '020']), 0));
    fireEvent.focus(markFor('sand-dev'));
    expect(noSurface()).toBe(false);

    // The row narrowed off or collapsed away: its `<rect>` unmounts, and a
    // surface pointing at a mark that is not on the chart is worse than none.
    //
    rerender(draw(oneBarPlan(), 0));
    expect(noSurface()).toBe(true);

    // **And it does not come back when the row does.** The assertion above is
    // the one that cannot fail on its own: a surface whose bar is gone renders
    // nothing whether or not the state behind it was cleared, so deleting the
    // close left all 63 tests green — watched, 2026-08-09. What the close
    // actually buys is this: expanding the branch again brings the `<rect>`
    // back, and a surface nobody asked for reopens at the rectangle the bar
    // used to be at.
    //
    // Proof: the anchor-gone effect deleted — this test alone failed, on
    // `expected false to be true`, with the surface back over a bar the
    // pointer had never returned to. Watched, 2026-08-09.
    rerender(draw(twoBarPlan(['010', '020']), 0));

    expect(noSurface()).toBe(true);
  });

  itDom('closes on a new chart read even where React reuses the very same node', () => {
    const { rerender } = render(draw(twoBarPlan(['010', '020']), 0));
    const anchor = markFor('strip-dev');
    fireEvent.focus(anchor);
    expect(noSurface()).toBe(false);

    // The same slice ids and different numbers: React keeps every `<rect>`,
    // nothing unmounts, and the identity assertion below is what says so — a
    // test that did not make it would be asserting the unmount close over
    // again and would prove nothing about this one.
    rerender(draw(twoBarPlan(['3.1', '3.2']), 1));

    // Proof: the reused node. `markFor('strip-dev')` is the same element
    // before and after, so the anchor-gone effect cannot fire — with the
    // generation effect deleted this failed on `expected false to be true`
    // while `closes when the bar it was opened on is no longer drawn` stayed
    // green, which is the whole reason both exist. Watched, 2026-08-09.
    expect(markFor('strip-dev')).toBe(anchor);
    expect(labelOf(markFor('strip-dev'))).toContain('3.1 - Strip');
    expect(noSurface()).toBe(true);
  });

  itDom('closes when the panel is scrolled', () => {
    render(draw(twoBarPlan(['010', '020']), 0));
    fireEvent.focus(markFor('strip-dev'));
    expect(noSurface()).toBe(false);

    // Proof: the `dismiss()` dropped from the panel's `onScroll` — this failed
    // on `expected false to be true`, a fixed surface left pointing at where a
    // bar used to be. Watched, 2026-08-09.
    fireEvent.scroll(screen.getByLabelText('Gantt chart'));

    expect(noSurface()).toBe(true);
  });
});

describe('the axis says its date, at the chart’s own speed', () => {
  const drawDated = (startDate: IsoDate | null) =>
    render(
      <GanttPanel
        plan={planOf({
          rows: [rowAt('strip', 0, 10)],
          slices: [sliceAt('strip-dev', 'strip', 0, 10)],
        })}
        startDate={startDate}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

  const axisPointer = (kind: 'mouse' | 'touch', name: 'pointerover' | 'pointerout'): Event => {
    const event = new Event(name, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'pointerType', { value: kind });
    return event;
  };

  const cellAt = (offset: number): Element => {
    const cell = document.querySelector(`[data-axis-day="${String(offset)}"]`);
    if (cell === null) throw new Error(`no axis cell at offset ${String(offset)}`);
    return cell;
  };

  itDom('names the day and its month after the chart’s delay, not the browser’s', () => {
    vi.useFakeTimers();
    try {
      drawDated(MONDAY_START);
      // Cell 7 is Monday 2026-08-17, workday 5 — past the first weekend, where
      // a raw offset and a calendar day disagree.
      fireEvent(cellAt(7), axisPointer('mouse', 'pointerover'));
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(linesOf(screen.getByRole('tooltip'))).toEqual(['Mon 17 Aug 2026', 'Workday 5']);
      // One hint, and it is the card: the native title is gone.
      expect(cellAt(7).getAttribute('title')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  itDom('calls a Saturday a weekend, not a workday', () => {
    vi.useFakeTimers();
    try {
      drawDated(MONDAY_START);
      // Cell 5 is Saturday 2026-08-15: nobody's workday.
      fireEvent(cellAt(5), axisPointer('mouse', 'pointerover'));
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(linesOf(screen.getByRole('tooltip'))).toEqual(['Sat 15 Aug 2026', 'Weekend']);
    } finally {
      vi.useRealTimers();
    }
  });

  itDom('says the workday alone when the plan is not on a calendar', () => {
    vi.useFakeTimers();
    try {
      drawDated(null);
      fireEvent(cellAt(5), axisPointer('mouse', 'pointerover'));
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(linesOf(screen.getByRole('tooltip'))).toEqual(['Workday 5']);
    } finally {
      vi.useRealTimers();
    }
  });

  itDom('opens nothing for a pointer that crosses the axis', () => {
    vi.useFakeTimers();
    try {
      drawDated(MONDAY_START);
      fireEvent(cellAt(7), axisPointer('mouse', 'pointerover'));
      fireEvent(cellAt(7), axisPointer('mouse', 'pointerout'));
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(noSurface()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  itDom('opens nothing for a pointer that is not a mouse', () => {
    // The bars' touch seam, on the axis: Chromium synthesizes mouse events
    // from a tap, and the pointer events are the only ones that say which
    // they came from.
    vi.useFakeTimers();
    try {
      drawDated(MONDAY_START);
      fireEvent(cellAt(7), axisPointer('touch', 'pointerover'));
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(noSurface()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  itDom('keeps one card on the page: the axis’s replaces a bar’s', () => {
    vi.useFakeTimers();
    try {
      drawDated(MONDAY_START);
      const bar = document.querySelector('[data-gantt-bar="strip-dev"]');
      if (bar === null) throw new Error('no bar to rest on');
      fireEvent(bar, axisPointer('mouse', 'pointerover'));
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      fireEvent(cellAt(7), axisPointer('mouse', 'pointerover'));
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      // `getByRole` throws where two match — this is the one-at-a-time
      // assertion, and the card standing is the axis's.
      expect(linesOf(screen.getByRole('tooltip'))[0]).toBe('Mon 17 Aug 2026');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the dates a bar says are printed by shortIsoDate and nothing else', () => {
  itDom('prints a day in another year with that year on it', () => {
    // `shortIsoDate` drops the year only when it matches the reader's own, so a
    // plan running in 2027 prints `1 Jun 2027` — which `shortInstant` and a
    // hand-rolled `toLocaleDateString` both spell differently.
    //
    // Proof, in two runs and both watched 2026-08-09:
    //   `shortIsoDate` replaced by `(iso) => new Date(iso).toLocaleDateString()`
    //     — this failed on `expected [ …(5) ] to include '1 Jun 2027 → 1 Jun
    //     2027 · 1 day'`, the surface reading `6/1/2027 → 6/1/2027`;
    //   the same replacement under `TZ=America/Los_Angeles`, where the parse of
    //     a zone-free day is midnight **UTC** read back in a zone behind it:
    //     `reads the same dates under a bar as the row’s Start and End cells`
    //     failed with the surface naming 12 Aug for 2026-08-13. The zone has to
    //     be behind UTC for the parse to move the day — Auckland and UTC both
    //     answer 13 Aug — so a negative run in a zone ahead of it is one that
    //     cannot fail.
    render(
      <GanttPanel
        plan={planOf({
          rows: [rowAt('strip', 0, 1, { number: '010', name: 'Strip' })],
          slices: [sliceAt('strip-dev', 'strip', 0, 1)],
        })}
        // A Tuesday, so the origin is the day itself.
        startDate="2027-06-01"
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    expect(linesOf(surfaceOn('strip-dev'))).toContain('1 Jun 2027 → 1 Jun 2027 · 1 day');
  });
});

describe('the height a drag may settle at', () => {
  // Pure arithmetic, no DOM: the same function is the drag's clamp and the
  // stored-height check, so these cases bound both at once.
  it('stops a drag below the floor at the floor', () => {
    expect(clampedGanttHeight(10, 900)).toBe(GANTT_MIN_PX);
    expect(clampedGanttHeight(-500, 900)).toBe(GANTT_MIN_PX);
  });

  it('stops a drag above the ceiling at the ceiling, however tall the screen', () => {
    expect(clampedGanttHeight(99999, 100000)).toBe(GANTT_CEILING_PX);
  });

  it('keeps the chart to 80% of the viewport it is really on', () => {
    expect(clampedGanttHeight(900, 1000)).toBe(800);
  });

  it('leaves a height every bound allows alone', () => {
    expect(clampedGanttHeight(400, 1000)).toBe(400);
  });

  it('holds the floor even on a viewport whose 80% is below it', () => {
    // 80% of 90px is 72, under the 84px floor: the floor wins, because a
    // panel below it shows nothing worth keeping open — the CSS max-height
    // is what keeps it on such a screen, not the clamp.
    expect(clampedGanttHeight(84, 90)).toBe(GANTT_MIN_PX);
  });
});

describe('the height the panel is drawn at', () => {
  const panelAt = (heightPx: number | null): HTMLElement => {
    render(
      <GanttPanel
        plan={planOf({
          rows: [rowAt('r1', 0, 2, { number: '010', name: 'One' })],
          slices: [sliceAt('r1-dev', 'r1', 0, 2)],
        })}
        startDate={null}
        scheduleError={null}
        generation={0}
        heightPx={heightPx}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );
    const panel = document.querySelector('[data-gantt-panel]');
    if (!(panel instanceof HTMLElement)) throw new Error('no gantt panel rendered');
    return panel;
  };

  itDom('keeps its bounded default share while nothing has been dragged', () => {
    const panel = panelAt(null);
    expect(panel.classList.contains('max-h-[40vh]')).toBe(true);
    expect(panel.style.height).toBe('');
  });

  itDom('is drawn at the override, under the live viewport cap', () => {
    const panel = panelAt(400);
    expect(panel.style.height).toBe('400px');
    expect(panel.style.maxHeight).toBe('80vh');
    expect(panel.classList.contains('max-h-[40vh]')).toBe(false);
  });
});

describe('the pointed row', () => {
  const MONDAY = '2026-06-01' as IsoDate;

  /**
   * A pointer event of one kind or the other, built by hand.
   *
   * jsdom has no `PointerEvent`, so `fireEvent.pointerOver(node, { pointerType
   * })` builds a plain `Event` and drops the init's `pointerType` — the guard
   * then reads `undefined` and refuses, and every assertion about the pointer
   * path passes because nothing was ever pointed. The hover suite above carries
   * the same helper for the same reason; both are the trap, not a preference.
   */
  const pointerEvent = (kind: 'mouse' | 'touch', name: 'pointerover' | 'pointerout'): Event => {
    const event = new Event(name, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'pointerType', { value: kind });
    Object.defineProperty(event, 'relatedTarget', { value: null });
    return event;
  };

  /** Two estimated rows, and a third nobody has estimated at all. */
  const plan = (): GanttPlan =>
    planOf({
      rows: [
        rowAt('strip', 0, 3, { number: '010', name: 'Strip' }),
        rowAt('sand', 3, 5, { number: '020', name: 'Sand' }),
        rowAt('seal', 0, 0, { number: '030', name: 'Seal' }),
      ],
      slices: [sliceAt('strip-dev', 'strip', 0, 3), sliceAt('sand-dev', 'sand', 3, 5)],
    });

  const draw = (
    pointedRow: string | null,
    onPointRow: (rowId: string | null, from: 'pointer' | 'focus') => void,
  ) => (
    <GanttPanel
      plan={plan()}
      startDate={MONDAY}
      scheduleError={null}
      generation={0}
      heightPx={null}
      onPickRow={() => undefined}
      onPointRow={onPointRow}
      pointedRow={pointedRow}
    />
  );

  /** The row label button for a work item id. */
  const labelFor = (rowId: string): Element => {
    const found = document.querySelector(`[data-gantt-label="${rowId}"]`);
    if (found === null) throw new Error(`no row label for ${rowId}`);
    return found;
  };

  /** The row indices the chart has drawn a pointed band across. */
  const litBands = (): string[] =>
    [...document.querySelectorAll('[data-gantt-row-lit]')].map(
      (rect) => rect.getAttribute('data-gantt-row-lit') ?? '(none)',
    );

  /** The ids of every row label the chart has lit. */
  const litLabels = (): string[] =>
    [...document.querySelectorAll('[data-gantt-label-lit]')].map(
      (button) => button.getAttribute('data-gantt-label') ?? '(none)',
    );

  itDom('reports a bar’s row on the pointer, immediately and with no timer', () => {
    vi.useFakeTimers();
    try {
      const pointed: [string | null, string][] = [];
      render(
        draw(null, (rowId, from) => {
          pointed.push([rowId, from]);
        }),
      );

      fireEvent(markFor('sand-dev'), pointerEvent('mouse', 'pointerover'));

      // No timer advanced. The 220ms delay is the surface's alone: a tint is
      // cheap to paint and cheap to be wrong about for a moment, and a reader
      // deliberately resting on a bar should not wait a fifth of a second to
      // find out which row it is.
      expect(pointed).toEqual([['sand', 'pointer']]);
      expect(screen.queryByRole('tooltip')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  itDom('reports null when the pointer leaves a bar', () => {
    const pointed: [string | null, string][] = [];
    render(
      draw(null, (rowId, from) => {
        pointed.push([rowId, from]);
      }),
    );

    fireEvent(markFor('strip-dev'), pointerEvent('mouse', 'pointerover'));
    fireEvent(markFor('strip-dev'), pointerEvent('mouse', 'pointerout'));

    expect(pointed).toEqual([
      ['strip', 'pointer'],
      [null, 'pointer'],
    ]);
  });

  itDom('reports a bar’s row from the keyboard, as a focus', () => {
    const pointed: [string | null, string][] = [];
    render(
      draw(null, (rowId, from) => {
        pointed.push([rowId, from]);
      }),
    );

    fireEvent.focus(markFor('sand-dev'));
    fireEvent.blur(markFor('sand-dev'));

    // The `from` is what keeps the two apart in the caller: a bar's blur must
    // not clear a light the pointer is holding somewhere else.
    expect(pointed).toEqual([
      ['sand', 'focus'],
      [null, 'focus'],
    ]);
  });

  itDom('is not pointed by a tap', () => {
    const pointed: [string | null, string][] = [];
    render(
      draw(null, (rowId, from) => {
        pointed.push([rowId, from]);
      }),
    );

    fireEvent(markFor('strip-dev'), pointerEvent('touch', 'pointerover'));

    expect(pointed).toEqual([]);
  });

  itDom('lights the row label and a band for the row it is handed', () => {
    render(draw('sand', () => undefined));

    expect(litLabels()).toEqual(['sand']);
    // Row index 1 — `sand` is the second row — so this is not merely "a band
    // exists" but "the band is on the pointed row".
    expect(litBands()).toEqual(['1']);
  });

  itDom('lights nothing while no row is pointed', () => {
    render(draw(null, () => undefined));

    expect(litLabels()).toEqual([]);
    expect(litBands()).toEqual([]);
  });

  itDom('lights nothing for a row this drawing does not hold', () => {
    // A row a search has narrowed out of the plan, or one a refetch has taken
    // away. The id resolves against `chart.labels`, so it finds no row and
    // draws nothing — rather than a band at row 0, which is what an index
    // fallback would put on screen.
    render(draw('a-row-that-is-not-drawn', () => undefined));

    expect(litLabels()).toEqual([]);
    expect(litBands()).toEqual([]);
  });

  itDom('is pointable from its row label, which is how a row with no bar is reached', () => {
    const pointed: [string | null, string][] = [];
    render(
      draw(null, (rowId, from) => {
        pointed.push([rowId, from]);
      }),
    );

    // `seal` is estimated by nobody, so the chart draws it no bar at all. Its
    // label is the only mark it has, and it has to be enough.
    expect(document.querySelector('[data-gantt-bar="seal-dev"]')).toBeNull();

    fireEvent(labelFor('seal'), pointerEvent('mouse', 'pointerover'));
    expect(pointed).toEqual([['seal', 'pointer']]);

    fireEvent(labelFor('seal'), pointerEvent('mouse', 'pointerout'));
    expect(pointed).toEqual([
      ['seal', 'pointer'],
      [null, 'pointer'],
    ]);
  });

  itDom('lights a band across an unestimated row it is handed', () => {
    render(draw('seal', () => undefined));

    expect(litLabels()).toEqual(['seal']);
    expect(litBands()).toEqual(['2']);
  });
});

describe('downloading the chart as a standalone .svg', () => {
  /**
   * What `URL.createObjectURL` was handed, and what an anchor was told to
   * download — `wbs-table.test.tsx`'s `captureDownloads`, copied rather than
   * imported: jsdom implements neither the object URL nor a download, so both
   * are replaced for the length of a test and put back after.
   */
  const captureDownloads = (): { blobs: Blob[]; names: string[] } => {
    const blobs: Blob[] = [];
    const names: string[] = [];
    const urls = URL as unknown as {
      createObjectURL: (blob: Blob) => string;
      revokeObjectURL: (url: string) => void;
    };
    urls.createObjectURL = (blob: Blob) => {
      blobs.push(blob);
      return `blob:gantt-${String(blobs.length)}`;
    };
    urls.revokeObjectURL = () => undefined;
    HTMLAnchorElement.prototype.click = function capture(this: HTMLAnchorElement) {
      names.push(this.download);
    };
    return { blobs, names };
  };

  afterEach(() => {
    Reflect.deleteProperty(URL, 'createObjectURL');
    Reflect.deleteProperty(URL, 'revokeObjectURL');
    Reflect.deleteProperty(HTMLAnchorElement.prototype, 'click');
  });

  /** A blob's text, through `FileReader` — jsdom's `Blob` has no `text()`. */
  const readBlobText = (blob: Blob): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const read = reader.result;
        if (typeof read === 'string') resolve(read);
        else reject(new Error('the downloaded blob read back as something other than text'));
      };
      reader.onerror = () => {
        reject(new Error('the downloaded blob could not be read'));
      };
      reader.readAsText(blob);
    });

  const twoRolePlan = (): GanttPlan =>
    planOf({
      rows: [rowAt('hull', 0, 7, { number: '010', name: 'Hull' })],
      slices: [
        sliceAt('hull-dev', 'hull', 0, 7, { personId: 'kat' }),
        sliceAt('hull-qa', 'hull', 7, 8, { roleId: 'qa' }),
      ],
      roles: [
        { id: 'dev', name: 'Dev' },
        { id: 'qa', name: 'QA' },
      ],
      personNames: new Map([['kat', 'Kat']]),
    });

  const clickDownload = (): void => {
    const button = document.querySelector('[data-gantt-svg-download]');
    if (!(button instanceof HTMLElement)) throw new Error('no download control on the panel');
    fireEvent.click(button);
  };

  itDom('puts a download control in the panel corner, without a toolbar button', () => {
    render(
      <GanttPanel
        plan={twoRolePlan()}
        startDate={MONDAY_START}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );
    const button = document.querySelector('[data-gantt-svg-download]');
    expect(button).not.toBeNull();
    expect(button?.getAttribute('aria-label')).toBe('Download this chart as a standalone SVG');
  });

  itDom('draws the downloaded axis at the rung the chart is on screen at', async () => {
    // The drift a threaded scale can have, and the only place it cannot be
    // checked for after the fact: the nested `<svg>` brings the live geometry
    // over at whatever width the panel sized it to, while the axis, the label
    // column and the on-bar words are rebuilt here from pixel arithmetic. A
    // constant in that arithmetic gives a file whose calendar is spaced 28px
    // apart over bars laid out 4px apart — every date over the wrong bar, in a
    // file with no app around it to notice.
    //
    // Written because the injection that should have caught it did not: with
    // `day.offset * dayPx` put back to `day.offset * DAY_PX`, the whole spec
    // stayed green at 137 passed. Every download case above runs at the default
    // rung, where the constant and the value agree. Watched 2026-08-23.
    render(
      <GanttPanel
        plan={twoRolePlan()}
        startDate={MONDAY_START}
        scheduleError={null}
        generation={0}
        heightPx={null}
        dayPx={4}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );
    const { blobs } = captureDownloads();
    clickDownload();

    const doc = new DOMParser().parseFromString(await readBlobText(blobs[0]), 'image/svg+xml');
    expect(doc.querySelector('parsererror')).toBeNull();
    // The weekend bands are the axis cells that carry a width as well as a
    // position, so one of them says both halves of the arithmetic at once.
    const bands = [...doc.querySelectorAll('rect')].filter(
      (rect) => rect.getAttribute('fill-opacity') === '0.1',
    );
    expect(bands.length).toBeGreaterThan(1);
    for (const band of bands) expect(Number(band.getAttribute('width'))).toBe(4);
    // **The gap between two of them**, and not each one's own coordinate on a
    // grid: the first spelling of this assertion checked `(x − origin) % 4`,
    // which 28 satisfies too — 28 is a multiple of 4, so the injected constant
    // stayed green through it. A Saturday and its Sunday are adjacent cells, so
    // the step between them is one day, which is the number under test.
    const xs = bands.map((band) => Number(band.getAttribute('x'))).sort((a, b) => a - b);
    const steps = xs.slice(1).map((x, index) => x - (xs[index] ?? 0));
    expect(Math.min(...steps)).toBe(4);
    // Where the first one stands, off the origin the label column and the pad
    // put it at: the step alone would pass on an axis drawn at the right pitch
    // in the wrong place.
    expect((xs[0] ?? 0) - 176 - CHART_PAD_PX).toBe(5 * 4);
    // And the nested live geometry is the same width the axis was drawn for, so
    // the two halves of the file are one chart: the outer `<svg>`'s width is
    // the label column plus the nested one's.
    const nested = doc.querySelector('svg svg');
    const outer = Number(doc.documentElement.getAttribute('width'));
    expect(outer).toBe(176 + Number(nested?.getAttribute('width')));
  });

  itDom('downloads a well-formed, self-contained .svg carrying the chart’s own marks', async () => {
    render(
      <GanttPanel
        plan={twoRolePlan()}
        startDate={MONDAY_START}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );
    const { blobs, names } = captureDownloads();
    clickDownload();

    expect(names).toEqual([expect.stringMatching(/^gantt-chart-\d{4}-\d{2}-\d{2}\.svg$/)]);
    expect(blobs).toHaveLength(1);
    expect(blobs[0]?.type).toBe('image/svg+xml;charset=utf-8');

    const text = await readBlobText(blobs[0]);
    expect(text.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);

    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    expect(doc.querySelector('parsererror')).toBeNull();
    const root = doc.documentElement;
    expect(root.tagName).toBe('svg');
    expect(root.getAttribute('xmlns')).toBe('http://www.w3.org/2000/svg');

    // The row label and the axis's month caption — neither exists inside the
    // live `<svg>` at all (design §1, "every word is HTML around it"), so
    // their presence here is the one thing that cannot be a clone of
    // anything.
    expect(text).toContain('010 - Hull');
    expect(text).toContain('Aug 2026');

    // The geometry itself is a style-inlined clone: the mark survives with its
    // own data attribute and the class is gone -- jsdom loads no stylesheet,
    // so getComputedStyle on the live weekend band answers nothing to inline
    // in its place. That the empty answer becomes a literal colour in a real
    // browser is that browser's own proof (Playwright on h2puni, verify.md),
    // not this one's.
    const weekendBand = doc.querySelector('[data-gantt-weekend]');
    expect(weekendBand).not.toBeNull();
    expect(weekendBand?.getAttribute('class')).toBeNull();

    // A bar's own colour is already literal in the live app -- a JSX
    // fill={bar.personColor} attribute, never a class -- and travels
    // untouched, which jsdom resolves exactly as a real browser does because
    // nothing here depends on a stylesheet.
    const bar = doc.querySelector('[data-gantt-bar="hull-dev"]');
    expect(bar).not.toBeNull();
    expect(bar?.getAttribute('fill')).toBe(PERSON_BAR_COLORS[0]);

    // The theme actually resolved -- the background and the two hand-built
    // text layers read it directly, never through a class, so jsdom's empty
    // getComputedStyle answer falls back to FALLBACK_GANTT_THEME here and the
    // exact literal is checkable without a browser.
    expect(doc.querySelector('rect')?.getAttribute('fill')).toBe(FALLBACK_GANTT_THEME.background);
    const monthText = [...doc.querySelectorAll('text')].find((t) => t.textContent === 'Aug 2026');
    expect(monthText?.getAttribute('fill')).toBe(FALLBACK_GANTT_THEME.mutedForeground);

    // The bar's own overlay text -- HTML on screen, <text> here -- carries the
    // same words the live label span shows, read off the same pure helpers.
    const liveLabel = document.querySelector('[data-gantt-bar-label="hull-dev"]');
    expect(liveLabel?.textContent).not.toBeNull();
    expect(text).toContain(liveLabel?.textContent ?? ' ');
  });

  itDom(
    'strips the class from every class-driven mark, even where jsdom cannot resolve a literal to replace it with',
    async () => {
      render(
        <GanttPanel
          plan={twoRolePlan()}
          startDate={MONDAY_START}
          scheduleError={null}
          generation={0}
          heightPx={null}
          onPickRow={() => undefined}
          onPointRow={() => undefined}
          pointedRow={null}
        />,
      );
      const { blobs } = captureDownloads();
      clickDownload();
      const text = await readBlobText(blobs[0]);
      const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
      // Every gridline is class-driven (stroke-border / stroke-border/40) in
      // the live app -- none may reach the file still carrying that class,
      // which would mean nothing outside the app it was drawn in.
      const gridlines = [...doc.querySelectorAll('[data-gantt-gridline]')];
      expect(gridlines.length).toBeGreaterThan(0);
      for (const line of gridlines) {
        expect(line.getAttribute('class')).toBeNull();
      }
      // Nor may role/tabindex -- a keyboard control in the app the file has
      // nothing behind, in a document with no reason to claim one.
      const anyBar = doc.querySelector('[data-gantt-bar]');
      expect(anyBar?.getAttribute('role')).toBeNull();
      expect(anyBar?.getAttribute('tabindex')).toBeNull();
    },
  );
});

describe('the waits the filter left undrawn', () => {
  /**
   * `strip` → `sand`, with `strip` off screen: the state a filter leaves the
   * chart in — the slices are all still in the payload, because be-01 schedules
   * the whole plan and the screen chooses what to draw.
   */
  const narrowedPast = (parts: Partial<GanttPlan> = {}): GanttPlan =>
    planOf({
      rows: [rowAt('sand', 3, 5)],
      slices: [sliceAt('strip-dev', 'strip', 0, 3), sliceAt('sand-dev', 'sand', 3, 5)],
      dependencies: [{ predecessorId: 'strip', successorId: 'sand' }],
      narrowedByFilter: true,
      ...parts,
    });

  /** The sentence under the chart, or null while there is none. */
  const droppedSentence = (): string | null =>
    document.querySelector('[data-gantt-dropped-links]')?.textContent ?? null;

  itDom('says under the chart how many waits it could not draw', () => {
    render(
      <GanttPanel
        plan={narrowedPast()}
        startDate={MONDAY_START}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    // The detail switch pressed, so the arrows that *can* be drawn are: the
    // sentence is about the one that cannot, not about a switch at rest.
    // `askForTheDetail` is not the helper for this — it throws when nothing
    // arrives, which is exactly the state under test.
    const detail = document.querySelector('[data-gantt-detail-toggle]');
    if (!(detail instanceof HTMLElement)) throw new Error('the detail switch is not on the panel');
    fireEvent.click(detail);

    expect(document.querySelectorAll('[data-gantt-arrow]')).toHaveLength(0);
    expect(droppedSentence()).toBe(
      'Not drawn: 1 wait whose other end this filter is hiding — 1 stored dependency. ' +
        'Clear the filter to see it.',
    );
  });

  /**
   * Outside the panel's scroll box, which is the whole of where it is: inside
   * it the sentence sits at the bottom of a canvas a 60-row plan scrolls, and a
   * reader who has not noticed a missing arrow never scrolls there.
   */
  itDom('puts the sentence outside the chart that scrolls', () => {
    render(
      <GanttPanel
        plan={narrowedPast()}
        startDate={MONDAY_START}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    const said = document.querySelector('[data-gantt-dropped-links]');
    expect(said?.closest('[data-gantt-panel]')).toBeNull();
  });

  itDom('says nothing while the filter is off, however the rows were narrowed', () => {
    render(
      <GanttPanel
        plan={narrowedPast({ narrowedByFilter: false })}
        startDate={MONDAY_START}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    expect(droppedSentence()).toBeNull();
  });

  itDom('says nothing when a filter drew every wait it has', () => {
    render(
      <GanttPanel
        plan={narrowedPast({
          rows: [rowAt('strip', 0, 3), rowAt('sand', 3, 5)],
        })}
        startDate={MONDAY_START}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    askForTheDetail();

    expect(document.querySelectorAll('[data-gantt-arrow]').length).toBeGreaterThan(0);
    expect(droppedSentence()).toBeNull();
  });
});

describe('today is marked on the chart', () => {
  // Dany, 2026-08-19: "on Gantt chart view I want to see the current date
  // marked". The plan runs eight workdays from Monday 2026-08-10, so its axis
  // is cells 0..9: Mon–Fri, the weekend at 5 and 6, then Mon–Wed the 19th. Ten
  // calendar cells for eight workdays, which is the weekend being two columns
  // wide rather than a seam.
  const eightWorkdays = (startDate: IsoDate | null) =>
    render(
      <GanttPanel
        plan={planOf({
          rows: [rowAt('strip', 0, 8)],
          slices: [sliceAt('strip-dev', 'strip', 0, 8)],
        })}
        startDate={startDate}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

  /** Draws the plan with the reader's clock standing at `at`, local time. */
  const onTheDay = (at: Date, startDate: IsoDate | null = MONDAY_START) => {
    vi.useFakeTimers();
    vi.setSystemTime(at);
    try {
      eightWorkdays(startDate);
    } finally {
      // Restored before the assertions: they touch nothing timed, and a suite
      // that leaves fake timers running poisons every test after it.
      vi.useRealTimers();
    }
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  itDom('draws today as a column, with its leading edge and its axis cell', () => {
    // Wednesday of the first week: the third cell, because the plan begins on a
    // Monday and nothing has intervened.
    onTheDay(new Date(2026, 7, 12, 9, 0));

    // A column a whole day wide rather than a hairline: what is known is which
    // *day* it is, and a 1px rule would claim an instant.
    expect(markAttribute('[data-gantt-today="2"]', 'x')).toBe('2');
    expect(markAttribute('[data-gantt-today="2"]', 'width')).toBe('1');
    expect(markAttribute('[data-gantt-today="2"]', 'height')).toBe('1');
    // The edge, over the gridlines, saying where the past stops.
    expect(markAttribute('[data-gantt-today-edge="2"]', 'class')).toBe('stroke-sky-500');
    // And the axis says it in text, not in colour alone.
    expect(markAttribute('[data-axis-day="2"]', 'aria-current')).toBe('date');
    expect(markAttribute('[data-axis-day="2"]', 'data-axis-date')).toBe('2026-08-12');
    // One reader, one today: no other cell claims it.
    expect(document.querySelectorAll('[aria-current="date"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-gantt-today]')).toHaveLength(1);
  });

  itDom('puts today in the weekend gap when the reader’s day is a Saturday', () => {
    // The case that needs no arm of its own, asserted because a reader would
    // reasonably expect one: cell 5 is the Saturday of the first week, it is a
    // column of the chart like any other, and today lands in it between
    // Friday's work and Monday's.
    onTheDay(new Date(2026, 7, 15, 9, 0));

    expect(markAttribute('[data-gantt-today="5"]', 'x')).toBe('5');
    // The weekend band is still there under it — two facts about one day, and
    // neither replaces the other.
    expect(markAttribute('[data-gantt-weekend="5"]', 'width')).toBe('1');
    expect(markAttribute('[data-axis-day="5"]', 'aria-current')).toBe('date');
  });

  itDom('draws no marker when today is before the plan begins', () => {
    // Dany's call, 2026-08-19, asked and answered before this was built: no
    // line rather than one pinned to the left edge, because a rule at the
    // margin reads as "today is the start date" — a sentence the chart would be
    // making up.
    //
    // Proof: the null arm replaced by `Math.max(0, …)` over a computed offset,
    // which is the obvious clamp — this failed on `expected
    // SVGRectElement{…} to be null`, a chart claiming the plan starts today
    // when today is a week before it. Watched 2026-08-19, see verify.md.
    onTheDay(new Date(2026, 7, 3, 9, 0));

    expect(document.querySelector('[data-gantt-today]')).toBeNull();
    expect(document.querySelector('[data-gantt-today-edge]')).toBeNull();
    expect(document.querySelector('[aria-current="date"]')).toBeNull();
    // The chart is still drawn: no marker is not no chart.
    expect(document.querySelectorAll('[data-axis-day]')).toHaveLength(10);
  });

  itDom('draws no marker when today is past the last day drawn', () => {
    // The same argument on the other side. A plan that finished in August is a
    // plan today is not on, and a rule pinned to the right edge would say it
    // finishes today.
    onTheDay(new Date(2026, 11, 1, 9, 0));

    expect(document.querySelector('[data-gantt-today]')).toBeNull();
    expect(document.querySelector('[aria-current="date"]')).toBeNull();
    expect(document.querySelectorAll('[data-axis-day]')).toHaveLength(10);
  });

  itDom('draws no marker at all on a plan with no start date', () => {
    // Nothing on the workday axis is a date, so there is no honest place to put
    // today on it — the same reason the hover text falls back to workday
    // offsets there. The lookup finds nothing without needing to know why:
    // every cell of `workdayAxis` carries `date: null`.
    //
    // Proof: `todayOffset` written to compare `day.offset` against a
    // `workdaysBetween` reading instead of matching on the date — this failed
    // on `expected SVGRectElement{…} to be null`, a marker on an axis with no
    // calendar, standing at whichever workday number the arithmetic produced.
    // Watched 2026-08-19, see verify.md.
    onTheDay(new Date(2026, 7, 12, 9, 0), null);

    expect(document.querySelector('[data-gantt-today]')).toBeNull();
    expect(document.querySelector('[data-gantt-today-edge]')).toBeNull();
    expect(document.querySelector('[aria-current="date"]')).toBeNull();
    expect(document.querySelectorAll('[data-axis-day]')).toHaveLength(8);
  });
});

describe('isoToday reads the reader’s own calendar, not UTC', () => {
  it('reads a late evening as the day the reader is having', () => {
    // The one place in this panel a `Date` becomes an `IsoDate`, and the
    // obvious spelling — `toISOString().slice(0, 10)` — is wrong: it converts
    // to UTC first, so late evening east of Greenwich answers tomorrow and the
    // marker stands a column right of where the reader's calendar has it.
    //
    // Built from local parts, so both assertions hold in every zone — and both
    // ends of the day are asserted because which end breaks depends on the
    // side of Greenwich: east of UTC the small hours read as yesterday, west of
    // it the late evening reads as tomorrow.
    //
    // Proof: `isoToday` written as `toISOString().slice(0, 10)` and this failed
    // under `TZ=Europe/Kyiv` on `expected '2026-08-18' to be '2026-08-19'` —
    // the 00:30 line below, a reader in Dany's own zone shown yesterday's
    // column as today for the first three hours of every day. Watched
    // 2026-08-19, see verify.md.
    expect(isoToday(new Date(2026, 7, 19, 23, 30))).toBe('2026-08-19');
    // And the small hours the other way, which is where a `toUTCString` habit
    // would answer yesterday.
    expect(isoToday(new Date(2026, 7, 19, 0, 30))).toBe('2026-08-19');
    // Both parts padded: a single-digit month and day are `01`, not `1`.
    expect(isoToday(new Date(2026, 0, 5, 12, 0))).toBe('2026-01-05');
  });
});

describe('the exported chart is named after the reader’s own day', () => {
  it('names the file after the reader’s own day, not UTC’s', () => {
    // The same fault `isoToday` exists for, in the one other place a `Date`
    // became a date in this file. It matters less than the marker — a filename
    // is not a plan — but it breaks the only property the name has: one name
    // per day. Through UTC, a download at 01:00 in Kyiv is named after
    // yesterday, so it collides with yesterday's 23:00 download and differs
    // from this morning's 10:00 one.
    //
    // Built from local parts, so the assertion holds in every zone; the fault
    // it guards manifests east of UTC and was watched under `TZ=Europe/Kyiv`.
    // See verify.md.
    expect(ganttSvgFileName(new Date(2026, 7, 19, 0, 30))).toBe('gantt-chart-2026-08-19.svg');
    expect(ganttSvgFileName(new Date(2026, 7, 19, 23, 30))).toBe('gantt-chart-2026-08-19.svg');
  });
});

describe('the day scale', () => {
  itDom('draws the axis and the canvas at the rung it is handed, not at the default', () => {
    // The defect this whole change exists for, stated as arithmetic: at 28px a
    // day a 390px phone sees six days of a quarter. Both numbers that turn user
    // space into pixels are checked together, because the fault a threaded
    // scale can have is that only one of them moved — an axis at 28 over a
    // canvas at 4 is a calendar that lies about every bar under it.
    const { rerender } = render(
      <GanttPanel
        plan={everyMarkOnOneDay()}
        startDate={MONDAY_START}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    const cellAt = (offset: number): HTMLElement => {
      const cell = document.querySelector<HTMLElement>(`[data-axis-day="${String(offset)}"]`);
      if (cell === null) throw new Error(`no axis cell at ${String(offset)}`);
      return cell;
    };
    const canvas = (): SVGSVGElement => {
      const svg = document.querySelector('[data-gantt-panel] svg');
      if (svg === null) throw new Error('no chart canvas');
      return svg as SVGSVGElement;
    };

    // The default, unchanged: this is the chart every pixel assertion above is
    // written against, asserted here so the rungs below are read as departures
    // from a measured baseline rather than from a remembered one.
    expect(cellAt(0).style.width).toBe(`${String(DAY_PX)}px`);
    const wideCanvas = Number(canvas().getAttribute('width'));
    const wideCells = document.querySelectorAll('[data-axis-day]').length;

    rerender(
      <GanttPanel
        plan={everyMarkOnOneDay()}
        startDate={MONDAY_START}
        scheduleError={null}
        generation={0}
        heightPx={null}
        dayPx={4}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    expect(cellAt(0).style.width).toBe('4px');
    // The canvas is `horizon × dayPx + 2 × CHART_PAD_PX`, so the pad survives
    // the rung and the schedule shrinks by exactly seven: subtracting the two
    // pads from each end is what says the band outside the schedule stayed a
    // pixel band rather than being scaled with the days.
    const narrowCanvas = Number(canvas().getAttribute('width'));
    expect(narrowCanvas - 2 * CHART_PAD_PX).toBeCloseTo((wideCanvas - 2 * CHART_PAD_PX) / 7, 6);
    // Every cell is still there — the compressed axis loses glyphs, never days.
    // A cell that vanished would take its weekend band, its today marker and
    // its hover card with it. Counted against the **wide** axis taken before
    // the rerender rather than against a written-out number, so a plan edited
    // above cannot make this pass by agreeing with itself.
    expect(document.querySelectorAll('[data-axis-day]').length).toBe(wideCells);
    expect(wideCells).toBeGreaterThan(1);
  });

  itDom('keeps the week boundaries printed when the numbers stop fitting', () => {
    // The axis rule, taken directly rather than through a render: two digits at
    // 10px need about 11, so below AXIS_NUMBER_PX only the heavy cells print.
    // The heavy one prints at **every** rung, because the week boundary is the
    // rhythm a compressed axis is read by — an axis with nothing printed on it
    // anywhere is a grey band, not a calendar.
    expect(axisNumberShown({ shown: '17', heavy: true }, DAY_PX)).toBe('17');
    expect(axisNumberShown({ shown: '18', heavy: false }, DAY_PX)).toBe('18');
    expect(axisNumberShown({ shown: '17', heavy: true }, 4)).toBe('17');
    expect(axisNumberShown({ shown: '18', heavy: false }, 4)).toBe('');
    // 12 is under the threshold too: the middle rung is a month on a phone, and
    // 30 two-digit numbers in 366px is the same smear 91 of them would be.
    expect(axisNumberShown({ shown: '18', heavy: false }, 12)).toBe('');
  });

  itDom('offers every rung, and reports the one that was picked', () => {
    const picked: number[] = [];
    render(
      <GanttPanel
        plan={everyMarkOnOneDay()}
        startDate={MONDAY_START}
        scheduleError={null}
        generation={0}
        heightPx={null}
        dayPx={DAY_PX}
        onPickDayPx={(rung) => picked.push(rung)}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    const control = document.querySelector<HTMLSelectElement>('[data-gantt-day-scale]');
    if (control === null) throw new Error('no day-scale control');
    // The control offers the ladder itself, not a copy of it: a hand-written
    // list here would go on passing after a rung was added or dropped.
    expect([...control.options].map((option) => Number(option.value))).toEqual([...DAY_SCALES]);
    expect(control.value).toBe(String(DAY_PX));

    fireEvent.change(control, { target: { value: '4' } });
    // Reported and **not** applied here: the panel draws what it is handed and
    // remembers nothing, which is what lets the scale be a per-project answer
    // the table stores. A panel that moved its own scale would show one thing
    // while storage held another.
    expect(picked).toEqual([4]);
    expect(control.value).toBe(String(DAY_PX));
  });

  itDom('collapses the name column away, and the chart keeps every day it had', () => {
    // The chunk's whole arithmetic: the column is a fixed 176px whatever the
    // rung is, so on the 343px a 390px phone gives this panel it is more than
    // half the width and worth more than any rung below 28px. What is asserted
    // is that collapsing it costs the chart **nothing** — same cells, same
    // canvas width — because the column is a sibling of the chart and not a
    // slice out of it. A collapse that reflowed the chart would be a second
    // scale with nothing checking it against the first.
    const { rerender } = render(
      <GanttPanel
        plan={everyMarkOnOneDay()}
        startDate={MONDAY_START}
        scheduleError={null}
        generation={0}
        heightPx={null}
        dayPx={4}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );
    const canvasWidth = (): string | null =>
      document.querySelector('[data-gantt-panel] svg')?.getAttribute('width') ?? null;

    const column = document.querySelector('[data-gantt-labels]');
    if (column === null) throw new Error('no label column');
    expect((column as HTMLElement).style.width).toBe(`${String(LABEL_COLUMN_PX)}px`);
    const shownCells = document.querySelectorAll('[data-axis-day]').length;
    const shownCanvas = canvasWidth();
    const shownNames = document.querySelectorAll('[data-gantt-label]').length;
    expect(shownNames).toBeGreaterThan(0);

    rerender(
      <GanttPanel
        plan={everyMarkOnOneDay()}
        startDate={MONDAY_START}
        scheduleError={null}
        generation={0}
        heightPx={null}
        dayPx={4}
        labelsShown={false}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    // Absent, not zero-width and not `hidden`: the names are buttons, and a
    // box of focusable controls nobody can see is a tab order into nowhere.
    expect(document.querySelectorAll('[data-gantt-labels]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-gantt-label]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-axis-day]')).toHaveLength(shownCells);
    expect(canvasWidth()).toBe(shownCanvas);
  });

  itDom('keeps the chart controls when the column they used to live in is gone', () => {
    // Chunk 1 left the scale, the detail switch and the download inside the
    // label column's sticky corner and wrote down the hazard. This is the case
    // that would have caught it: the same four controls are found with the
    // column collapsed, so the strip is outside it in fact rather than in the
    // comment. Injecting the old placement — the controls put back inside
    // `[data-gantt-labels]` — turns this red and nothing else in the file.
    const controls = (): string[] =>
      [
        '[data-gantt-labels-toggle]',
        '[data-gantt-detail-toggle]',
        '[data-gantt-day-scale]',
        '[data-gantt-svg-download]',
      ].filter((selector) => document.querySelector(selector) !== null);

    const { rerender } = render(
      <GanttPanel
        plan={everyMarkOnOneDay()}
        startDate={MONDAY_START}
        scheduleError={null}
        generation={0}
        heightPx={null}
        labelsShown={false}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );
    expect(controls()).toHaveLength(4);
    // And the month caption with them — it names the month the chart is
    // scrolled to, which is a fact about the calendar rather than about the
    // names beside it, so losing the column must not take it.
    expect(document.querySelector('[data-gantt-month]')?.textContent ?? '').not.toBe('');

    rerender(
      <GanttPanel
        plan={everyMarkOnOneDay()}
        startDate={MONDAY_START}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );
    expect(controls()).toHaveLength(4);
  });

  itDom('reports the names switch and does not act on it', () => {
    // The same bargain the rung makes, for the same reason: the panel draws
    // what it is handed and stores nothing, because the answer is remembered
    // per project and the table is the only place that knows which project this
    // is. `aria-pressed` is asserted against **shown**, not against collapsed —
    // the pressed state of a control has to be the state of the thing it is
    // named after.
    const picked: boolean[] = [];
    render(
      <GanttPanel
        plan={everyMarkOnOneDay()}
        startDate={MONDAY_START}
        scheduleError={null}
        generation={0}
        heightPx={null}
        labelsShown
        onPickLabelsShown={(shown) => picked.push(shown)}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointedRow={null}
      />,
    );

    const control = document.querySelector<HTMLButtonElement>('[data-gantt-labels-toggle]');
    if (control === null) throw new Error('no names control');
    expect(control.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(control);
    expect(picked).toEqual([false]);
    // Unmoved: the column is still drawn, because nothing here decided.
    expect(control.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelectorAll('[data-gantt-labels]')).toHaveLength(1);
  });

  itDom('refuses a scale that is not one of the rungs', () => {
    // The guard the storage boundary shares. Discrete and not a range: a stored
    // 9 is a width no control can get back to, so a chart opened at it would be
    // one nothing could return to a rung.
    expect(isDayPx(28)).toBe(true);
    expect(isDayPx(4)).toBe(true);
    expect(isDayPx(9)).toBe(false);
    expect(isDayPx('28')).toBe(false);
    expect(isDayPx(null)).toBe(false);
  });
});
