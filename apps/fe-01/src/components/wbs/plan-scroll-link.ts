/**
 * The one scroll position the plan's two faces share.
 *
 * The plan is drawn twice — the renderer above and the Gantt panel below it —
 * and until this module the two scrolled apart. A reader who scrolled to row 40
 * of a 60-row plan was looking at rows 1–12 of the chart, so the bar beside the
 * row was never the row's own bar. The panel papers over it with a duplicate
 * label column, which is why the fault survived: every bar is labelled, so
 * nothing on screen is *wrong* — it is just two plans instead of one.
 *
 * Recorded as an audit finding on 2026-08-11, from the Browser Use Cloud run:
 * "Table and Gantt scroll independently — can never read row N beside bar N;
 * Gantt papers over it with a duplicate truncated 176px label column."
 * (`notes/wbs-cloud-test-run-2026-08-11.md`, Group C.)
 *
 * **What "one surface" means here, exactly.** Not one scroll container: the two
 * faces scroll sideways for different reasons — the renderer for its columns
 * (`unfolding-may-scroll`), the panel for its calendar — and CSS gives no way
 * to share one axis and not the other, since `overflow-x: auto` forces the
 * other axis to compute to `auto` as well. What is shared is the **row**: the
 * row the renderer is showing first is the row the panel is showing first, and
 * a scroll of either face makes that true again. `design.md` has the
 * alternatives.
 *
 * **The pairing is by id, positioned by index.** The panel draws exactly the
 * rows the renderer draws, in that order — the invariant `gantt-panel.test.tsx`
 * pins from both ends ("draws exactly the rows a search narrowed the plan to",
 * "leaves a collapsed branch's children off the chart"). So the mate of row *i*
 * is row *i*, which is what keeps this O(log n) rect reads per scroll event
 * rather than O(n): a 500-row plan cannot afford a full measure per event. The
 * id is then **checked** rather than assumed, and a disagreement makes this do
 * nothing — the two faces are re-rendered by two different commits and there is
 * a tick where they disagree honestly.
 */

/** One row of one face of the plan, as a browser has it laid out. */
export interface LaidOutRow {
  /** The work item's id — the same id on both faces, which is what pairs them. */
  id: string;
  /** The row's top edge, in viewport pixels. */
  top: number;
  /** The row's bottom edge, in viewport pixels. */
  bottom: number;
}

/**
 * One face of the plan as this module needs it: where its content starts on
 * screen, how many rows it draws, and how to measure the *n*th of them.
 *
 * `at` is a function rather than an array because reading a rect is what forces
 * layout, and the search below asks for about ten of them out of however many
 * there are. An array parameter would measure every row of a 500-row plan on
 * every scroll event, which is the same information at forty times the cost.
 */
export interface PlanFace {
  /**
   * Where this face's own rows start on screen, in viewport pixels — the bottom
   * edge of its sticky heading, not the top edge of its scroll box. A row the
   * heading is painted over is not a row anybody is reading, and aligning to
   * the box's edge instead would hide the first row of the follower under its
   * own heading.
   */
  contentTop: number;
  /** How many rows this face draws. */
  count: number;
  /** The *n*th row, measured now. */
  at: (index: number) => LaidOutRow;
}

/**
 * How far the two faces may be out of step before a move is worth making, in
 * CSS pixels.
 *
 * One pixel, and it is what stops a link from being a loop as much as it is a
 * tolerance: a follower moved into place fires its own scroll event, that event
 * asks this module to align its driver, and the answer has to be "already
 * aligned" or the two would push each other for ever. Sub-pixel layout means
 * "already aligned" cannot be spelled `=== 0`.
 *
 * **It does two jobs under one name, and they are the same tolerance.** In
 * {@link alignmentMove} it is how far out of step is not worth a move; in
 * {@link firstShownIndex} it is how much of a row may be under the heading
 * before the row below it is the one being read. A reviewer read a bug into the
 * second (2026-08-12): two faces with different row heights can name different
 * first rows at the same position. They can — and it is not a disagreement,
 * because {@link alignmentMove} carries the cut as a fraction of the row, and
 * "row 3 with all of it above the line" and "row 4 at the line" are one
 * position. The residual the threshold leaves is `mateHeight / driverHeight`
 * pixels, under this constant by construction. Measured, not argued: the move
 * back from the disagreeing face is `null`.
 */
export const SETTLED_PX = 1;

/**
 * The index of the first row this face is showing, or `null` when it is showing
 * none.
 *
 * "Showing" includes a row the heading has half covered: that is the row a
 * reader is reading, and quantising to the first *whole* row would make a
 * follower jump a row at a time while its driver moved smoothly.
 *
 * A binary search, which is only allowed because row tops ascend with the index
 * — they are laid-out siblings in document order. `count` is trusted from the
 * DOM rather than derived here.
 */
export function firstShownIndex(face: PlanFace): number | null {
  let low = 0;
  let high = face.count - 1;
  let found: number | null = null;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (face.at(mid).bottom > face.contentTop + SETTLED_PX) {
      found = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return found;
}

/**
 * How far the follower has to scroll to be showing the row its driver is
 * showing, or `null` when it already is — or when there is no such row to
 * agree about.
 *
 * The number is a delta to add to `scrollTop`, not a position: the follower's
 * own scroll offset is not this module's business, and a delta is the same
 * arithmetic whichever face is which.
 *
 * Three answers are `null` and they are three different facts, all of them
 * ordinary rather than faults:
 *
 * - the driver is showing no row at all — an empty plan, or one scrolled past
 *   its last row into the frame's picker room;
 * - the follower has no row at that index, or has a different row's id there —
 *   the two faces are rendered by two commits and disagree for a tick;
 * - the follower is already showing it, which is every echo of a move this
 *   module itself made.
 */
export function alignmentMove(driver: PlanFace, follower: PlanFace): number | null {
  const index = firstShownIndex(driver);
  if (index === null || index >= follower.count) return null;
  const shown = driver.at(index);
  const mate = follower.at(index);
  if (mate.id !== shown.id) return null;
  // How far the driver's own row has gone under its heading, which the follower
  // copies rather than rounding away — otherwise a smooth scroll of one face
  // steps the other a whole row at a time.
  //
  // As a **fraction of the row** rather than as pixels, because the two rows
  // are not always the same height: a wrapped name makes a 46px row against the
  // panel's fixed 28, and carrying 40 of those pixels onto a 28px row would put
  // the mate entirely under the axis with the row *after* the reader's at the
  // top. A fraction of a row is inside the mate's own height by construction,
  // so there is nothing to clamp and no state in which the follower is showing
  // a different row from its driver. With the two heights equal — every row of
  // every plan whose names fit on one line — it is the pixel difference exactly.
  const shownHeight = shown.bottom - shown.top;
  const carried =
    shownHeight <= 0
      ? // Nothing of a row with no height is under anything. It is not a fault:
        // a row mid-remount measures zero, and the next event measures it again.
        0
      : ((shown.top - driver.contentTop) / shownHeight) * (mate.bottom - mate.top);
  const move = mate.top - (follower.contentTop + carried);
  return Math.abs(move) < SETTLED_PX ? null : move;
}

/**
 * Reads the renderer's face out of the frame that scrolls it.
 *
 * The heading is a heading **cell** and not the `<thead>`, because the cells are
 * what is sticky — `HEADER_CELL` in `table-frame.ts` says why, and a browser
 * says what it costs to forget: `<thead>` is not itself stuck, so its box rides
 * up with the scroll while its cells stay, and a content top measured from it
 * moves with the rows instead of standing still. Every row then measures as
 * showing, the first one always wins, and the chart sits on row 0 whatever the
 * table does. Watched on h2puni, 2026-08-12: the frame at `scrollTop 224` and
 * the panel at `0`, with `takes the chart to the row the table was scrolled to`
 * red on the frame having scrolled eight rows and the chart none.
 *
 * The rows are the ones carrying an id — `<tr data-row-id>`, the same attribute
 * the dependency proofs find a row by. Group rows and any other decoration are
 * not rows of the plan and are not counted, or the index would stop being the
 * panel's index.
 *
 * @throws When the frame holds no heading cell. This module aligns to the
 * bottom edge of one, and a frame without one is a table this module has never
 * seen — measuring from the box's own top instead would silently hide the first
 * row under the heading it could not find. R5: unknown is not OK.
 */
export function rendererFace(
  frame: HTMLElement,
  logicalRows?: readonly { id: string; startPx: number; sizePx: number }[],
): PlanFace {
  const heading = frame.querySelector('thead th');
  if (heading === null) {
    throw new Error('the plan frame has no heading cell to measure its content top from');
  }
  if (logicalRows !== undefined)
    return {
      contentTop: heading.getBoundingClientRect().bottom,
      count: logicalRows.length,
      at: (index) => {
        const row = logicalRows[index];
        const top = heading.getBoundingClientRect().bottom + row.startPx - frame.scrollTop;
        return { id: row.id, top, bottom: top + row.sizePx };
      },
    };
  const rows = frame.querySelectorAll('tbody tr[data-row-id]');
  return {
    contentTop: heading.getBoundingClientRect().bottom,
    count: rows.length,
    // No guard on the index: `count` above is this list's own length and both
    // callers stay inside it, so a check here could not be made to fail — which
    // is the shape of check this repository has a tally of.
    at: (index) => {
      const row = rows[index];
      const box = row.getBoundingClientRect();
      return { id: row.getAttribute('data-row-id') ?? '', top: box.top, bottom: box.bottom };
    },
  };
}

/**
 * Reads the panel's face out of the panel that scrolls it.
 *
 * The heading is the calendar axis rather than the label column's own caption:
 * the two are the same height by construction and the axis is the one that is
 * always drawn, dated plan or not.
 *
 * @throws When the panel holds no calendar axis, for `rendererFace`'s reason.
 */
export function panelFace(panel: HTMLElement): PlanFace {
  const axis = panel.querySelector('[data-gantt-axis]');
  if (axis === null) {
    throw new Error('the Gantt panel has no calendar axis to measure its content top from');
  }
  const labels = panel.querySelectorAll('[data-gantt-label]');
  return {
    contentTop: axis.getBoundingClientRect().bottom,
    count: labels.length,
    at: (index) => {
      const label = labels[index];
      const box = label.getBoundingClientRect();
      return { id: label.getAttribute('data-gantt-label') ?? '', top: box.top, bottom: box.bottom };
    },
  };
}

/**
 * Holds the renderer and the panel on one row, and returns the way to stop.
 *
 * Both faces listen, because either can be the one that moved: a wheel over the
 * chart is as much a scroll of the plan as a wheel over the table, and a
 * keyboard walk that carries the focus down the table is a third. Whichever
 * fired is the driver for that event and the other follows; neither is the
 * master.
 *
 * **Vertical only, and that is load-bearing.** `scrollLeft` is never read and
 * never written on either face. The renderer's is which columns are on screen
 * with a step unfolded (`unfolding-may-scroll`), the panel's is which fortnight
 * of the calendar is — and the panel's is also what its month caption is
 * computed from, so a link that touched it would make the caption name a month
 * the reader is not looking at.
 *
 * **The echo, and why there is no flag for it.** Moving the follower fires the
 * follower's own scroll event, which asks for the reverse alignment; that
 * answer is `null` because the two now agree, so the bounce stops after one and
 * costs a measurement. The one case that would not stop is a follower that
 * cannot reach where it was put — clamped at its own end — and re-reading
 * `scrollTop` after the write is what catches it: a write that moved nothing is
 * a write that will not echo, and a face pinned at its end is left alone until
 * its driver comes back to it.
 */
export function linkPlanScroll(
  frame: HTMLElement,
  panel: HTMLElement,
  logicalRows?: readonly { id: string; startPx: number; sizePx: number }[],
): () => void {
  /** The face whose next scroll event this module caused, if any. */
  let echo: HTMLElement | null = null;

  const follow = (driverPort: HTMLElement, followerPort: HTMLElement) => {
    if (echo === driverPort) {
      echo = null;
      return;
    }
    const readFace = (port: HTMLElement) =>
      port === frame ? rendererFace(frame, logicalRows) : panelFace(panel);
    const move = alignmentMove(readFace(driverPort), readFace(followerPort));
    if (move === null) return;
    const before = followerPort.scrollTop;
    followerPort.scrollTop = before + move;
    // A write that changed nothing fires no event, so claiming an echo for it
    // would swallow the follower's next real scroll instead.
    if (followerPort.scrollTop !== before) echo = followerPort;
  };

  const onFrameScroll = () => {
    follow(frame, panel);
  };
  const onPanelScroll = () => {
    follow(panel, frame);
  };
  frame.addEventListener('scroll', onFrameScroll, { passive: true });
  panel.addEventListener('scroll', onPanelScroll, { passive: true });
  return () => {
    frame.removeEventListener('scroll', onFrameScroll);
    panel.removeEventListener('scroll', onPanelScroll);
  };
}
