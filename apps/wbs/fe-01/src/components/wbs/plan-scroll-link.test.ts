import { describe, expect, it } from 'vitest';

import {
  alignmentMove,
  firstShownIndex,
  linkPlanScroll,
  panelFace,
  type PlanFace,
  rendererFace,
  SETTLED_PX,
} from './plan-scroll-link';

/** A row height the panel draws every row at, and the table draws most at. */
const ROW = 28;
/** What both faces' headings are worth, which is one row on each. */
const HEADING = 28;

/**
 * A face laid out from a list of rows, each with its own height.
 *
 * The arithmetic under test is about pixels a browser produced, so the fixture
 * produces them the way a browser would: rows stacked from the content top,
 * moved up by however far the face is scrolled.
 */
function laidOut(
  rows: readonly { id: string; height?: number }[],
  { contentTop = 100, scrolled = 0 } = {},
): PlanFace {
  const tops: number[] = [];
  let running = contentTop - scrolled;
  for (const row of rows) {
    tops.push(running);
    running += row.height ?? ROW;
  }
  return {
    contentTop,
    count: rows.length,
    at: (index) => {
      const row = rows[index];
      const top = tops[index];
      return { id: row.id, top, bottom: top + (row.height ?? ROW) };
    },
  };
}

/** Twenty rows, which is enough for the search to have to search. */
const TWENTY = Array.from({ length: 20 }, (_, index) => ({ id: `row-${String(index)}` }));

describe('the row a face is showing first', () => {
  it('is the first one, unscrolled', () => {
    expect(firstShownIndex(laidOut(TWENTY))).toBe(0);
  });

  it('is the row the heading has half covered, not the first whole one', () => {
    // Ten pixels of row 3 are under the heading. A reader is reading row 3, and
    // a follower that rounded up to row 4 would step a whole row at a time
    // while its driver moved smoothly.
    expect(firstShownIndex(laidOut(TWENTY, { scrolled: 3 * ROW + 10 }))).toBe(3);
  });

  it('finds a row a long way down without measuring the ones above it', () => {
    const measured: number[] = [];
    const face = laidOut(TWENTY, { scrolled: 17 * ROW });
    const watched: PlanFace = {
      ...face,
      at: (index) => {
        measured.push(index);
        return face.at(index);
      },
    };
    expect(firstShownIndex(watched)).toBe(17);
    // A linear scan would be eighteen. The bound is the search's, and the point
    // of the search is a 500-row plan measuring ten rows per scroll event
    // rather than five hundred.
    expect(measured.length).toBeLessThanOrEqual(5);
  });

  it('is nothing when the face draws no rows', () => {
    expect(firstShownIndex(laidOut([]))).toBeNull();
  });

  it('is nothing when every row is above the heading', () => {
    // The frame scrolled past its last row into its own picker room, which is
    // 13rem of nothing and not a row to agree about.
    expect(firstShownIndex(laidOut(TWENTY, { scrolled: 21 * ROW }))).toBeNull();
  });
});

describe('the move that puts the follower on the driver’s row', () => {
  it('is nothing when the two already agree', () => {
    expect(alignmentMove(laidOut(TWENTY), laidOut(TWENTY, { contentTop: 400 }))).toBeNull();
  });

  it('is the whole distance when the driver has scrolled and the follower has not', () => {
    const driver = laidOut(TWENTY, { scrolled: 6 * ROW });
    const follower = laidOut(TWENTY, { contentTop: 400 });
    // The follower's row 6 stands six rows below its content top and has to
    // come up by exactly that.
    expect(alignmentMove(driver, follower)).toBe(6 * ROW);
  });

  it('carries the part of the row the driver has under its heading', () => {
    const driver = laidOut(TWENTY, { scrolled: 6 * ROW + 11 });
    const follower = laidOut(TWENTY, { contentTop: 400 });
    // Eleven pixels further than the whole rows, so the follower's row 6 is cut
    // by eleven too rather than sitting flush.
    expect(alignmentMove(driver, follower)).toBe(6 * ROW + 11);
  });

  it('carries a fraction of the row, so a wrapped name cannot overshoot', () => {
    // A wrapped name makes a 46px row in the table against the panel's fixed
    // 28. Scrolled 40px into it, a carry in pixels would push the panel's 28px
    // row entirely under its axis and leave the next row at the top — the row
    // after the one the reader is on. As a fraction it is 40/46 of a 28px row.
    const driver = laidOut([{ id: 'a', height: 46 }, ...TWENTY], { scrolled: 40 });
    const follower = laidOut([{ id: 'a' }, ...TWENTY], { contentTop: 400 });
    const move = alignmentMove(driver, follower);
    expect(move).toBeCloseTo((40 / 46) * ROW, 5);
    // And the mate is still the row on show, which is the whole point of the
    // fraction: its bottom edge stays below the axis it is aligned under.
    expect(400 - (move ?? 0) + ROW).toBeGreaterThan(400);
  });

  it('is nothing when the row at that index is a different row', () => {
    // The two faces are rendered by two commits and there is a tick where they
    // disagree. Guessing across it would scroll the chart to somebody else's
    // bar, which is the fault this module exists to remove.
    const driver = laidOut(TWENTY, { scrolled: 6 * ROW });
    const follower = laidOut(
      TWENTY.map((row, index) => (index === 6 ? { id: 'somebody-else' } : row)),
      { contentTop: 400 },
    );
    expect(alignmentMove(driver, follower)).toBeNull();
  });

  it('is nothing when the follower has no row that far down', () => {
    const driver = laidOut(TWENTY, { scrolled: 15 * ROW });
    expect(alignmentMove(driver, laidOut(TWENTY.slice(0, 8), { contentTop: 400 }))).toBeNull();
  });

  it('is nothing for a difference too small to be worth a scroll', () => {
    const driver = laidOut(TWENTY, { scrolled: 6 * ROW });
    const follower = laidOut(TWENTY, { contentTop: 400, scrolled: 6 * ROW - SETTLED_PX / 2 });
    expect(alignmentMove(driver, follower)).toBeNull();
  });
});

/** A rect with the two edges this module reads and the rest of the shape. */
function boxAt(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 0,
    width: 0,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}

/** Lays an element out at a box that moves as its scrollport is scrolled. */
function place(element: Element, box: () => DOMRect): void {
  Object.defineProperty(element, 'getBoundingClientRect', { value: box });
}

/**
 * The table's face as a browser would hand it over: a frame, a sticky heading
 * and one `<tr>` per row, each measured against the frame's own scroll offset.
 */
function fakeFrame(ids: readonly string[], { contentTop = 100 } = {}): HTMLElement {
  const frame = document.createElement('div');
  const table = document.createElement('table');
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  const headCell = document.createElement('th');
  const body = document.createElement('tbody');
  // The cell rather than the group, because the cell is what is sticky: a
  // `<thead>` box rides up with the scroll while its cells stay put, which is
  // the fault a browser caught on 2026-08-12.
  place(headCell, () => boxAt(contentTop - HEADING, HEADING));
  headRow.append(headCell);
  head.append(headRow);
  ids.forEach((id, index) => {
    const row = document.createElement('tr');
    row.setAttribute('data-row-id', id);
    place(row, () => boxAt(contentTop + index * ROW - frame.scrollTop, ROW));
    body.append(row);
  });
  table.append(head, body);
  frame.append(table);
  document.body.append(frame);
  return frame;
}

/** The panel's face, the same way: a calendar axis and one label per row. */
function fakePanel(ids: readonly string[], { contentTop = 500 } = {}): HTMLElement {
  const panel = document.createElement('section');
  const axis = document.createElement('div');
  axis.setAttribute('data-gantt-axis', '');
  place(axis, () => boxAt(contentTop - HEADING, HEADING));
  panel.append(axis);
  ids.forEach((id, index) => {
    const label = document.createElement('button');
    label.setAttribute('data-gantt-label', id);
    place(label, () => boxAt(contentTop + index * ROW - panel.scrollTop, ROW));
    panel.append(label);
  });
  document.body.append(panel);
  return panel;
}

const IDS = Array.from({ length: 20 }, (_, index) => `row-${String(index)}`);

describe('reading a face off the page', () => {
  it('refuses a frame whose heading has no cells', () => {
    // R5: the content top is the bottom edge of a heading, and measuring from
    // the box's own top instead would hide the follower's first row under a
    // heading this could not find. A `<thead>` with nothing in it is the sharp
    // end of that: it is on the page, it has a box, and its box is not the one
    // that stays still — which is the fault a browser caught on 2026-08-12.
    const frame = document.createElement('div');
    const table = document.createElement('table');
    table.append(document.createElement('thead'));
    frame.append(table);
    document.body.append(frame);
    expect(() => rendererFace(frame)).toThrow(/heading cell/);
  });

  it('refuses a panel with no calendar axis', () => {
    const panel = document.createElement('section');
    document.body.append(panel);
    expect(() => panelFace(panel)).toThrow(/calendar axis/);
  });

  it('counts the rows of the plan and not the decoration between them', () => {
    const frame = fakeFrame(IDS);
    const group = document.createElement('tr');
    frame.querySelector('tbody')?.append(group);
    // A `<tr>` with no id is a step group's heading, not a row of the plan.
    // Counting it would move every index below it off its own bar.
    expect(rendererFace(frame).count).toBe(IDS.length);
    expect(panelFace(fakePanel(IDS)).count).toBe(IDS.length);
  });
});

describe('the two faces held on one row', () => {
  it('takes the chart to the row the table was scrolled to', () => {
    const frame = fakeFrame(IDS);
    const panel = fakePanel(IDS);
    const stop = linkPlanScroll(frame, panel);

    frame.scrollTop = 7 * ROW;
    frame.dispatchEvent(new Event('scroll'));

    expect(panel.scrollTop).toBe(7 * ROW);
    stop();
  });

  it('takes the table to the row the chart was scrolled to', () => {
    const frame = fakeFrame(IDS);
    const panel = fakePanel(IDS);
    const stop = linkPlanScroll(frame, panel);

    panel.scrollTop = 4 * ROW;
    panel.dispatchEvent(new Event('scroll'));

    expect(frame.scrollTop).toBe(4 * ROW);
    stop();
  });

  it('does not push back when the follower reports the move it was given', () => {
    const frame = fakeFrame(IDS);
    const panel = fakePanel(IDS);
    const stop = linkPlanScroll(frame, panel);

    frame.scrollTop = 7 * ROW + 9;
    frame.dispatchEvent(new Event('scroll'));
    const followed = panel.scrollTop;
    // The echo. A browser fires this for the write above, and the answer to it
    // has to be "already aligned" — a second opinion here is a loop.
    panel.dispatchEvent(new Event('scroll'));

    expect(panel.scrollTop).toBe(followed);
    expect(frame.scrollTop).toBe(7 * ROW + 9);
    stop();
  });

  it('does not let a follower that ran out of chart drag its driver back', () => {
    const frame = fakeFrame(IDS);
    const panel = fakePanel(IDS);
    // A shorter chart than the table it follows: it stops 100px in, which is
    // where a browser clamps a `scrollTop` past the end of a scroll box.
    let held = 0;
    Object.defineProperty(panel, 'scrollTop', {
      get: () => held,
      set: (asked: number) => {
        held = Math.min(asked, 100);
      },
    });
    const stop = linkPlanScroll(frame, panel);

    frame.scrollTop = 7 * ROW;
    frame.dispatchEvent(new Event('scroll'));
    expect(panel.scrollTop).toBe(100);
    // The clamped landing fires its own scroll event, and answering that one
    // would pull the table back to where the chart ran out — a plan that
    // refuses to scroll past its chart's last row.
    panel.dispatchEvent(new Event('scroll'));

    expect(frame.scrollTop).toBe(7 * ROW);
    stop();
  });

  it('leaves a face that could not move free to drive the next gesture', () => {
    const frame = fakeFrame(IDS);
    const panel = fakePanel(IDS);
    // A panel pinned at its own end: the browser clamps, and the write that
    // moved nothing fires no event. Claiming an echo for it would swallow the
    // reader's next scroll of this panel instead.
    Object.defineProperty(panel, 'scrollTop', { get: () => 0, set: () => undefined });
    const stop = linkPlanScroll(frame, panel);

    frame.scrollTop = 7 * ROW;
    frame.dispatchEvent(new Event('scroll'));
    // Now the reader scrolls the panel itself — which is at 0, so the table has
    // to come back to row 0.
    panel.dispatchEvent(new Event('scroll'));

    expect(frame.scrollTop).toBe(0);
    stop();
  });

  it('never writes sideways, on either face', () => {
    const frame = fakeFrame(IDS);
    const panel = fakePanel(IDS);
    // The frame's is which columns are on screen with a step unfolded; the
    // panel's is which fortnight of the calendar is, and the month caption is
    // computed from it.
    frame.scrollLeft = 320;
    panel.scrollLeft = 140;
    const stop = linkPlanScroll(frame, panel);

    frame.scrollTop = 5 * ROW;
    frame.dispatchEvent(new Event('scroll'));
    panel.dispatchEvent(new Event('scroll'));

    expect(frame.scrollLeft).toBe(320);
    expect(panel.scrollLeft).toBe(140);
    stop();
  });

  it('stops listening when it is stopped', () => {
    const frame = fakeFrame(IDS);
    const panel = fakePanel(IDS);
    linkPlanScroll(frame, panel)();

    frame.scrollTop = 9 * ROW;
    frame.dispatchEvent(new Event('scroll'));

    expect(panel.scrollTop).toBe(0);
  });
});
