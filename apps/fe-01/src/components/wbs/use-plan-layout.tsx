import { type ExpandedState } from '@tanstack/react-table';
import type * as React from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import {
  clampedGanttHeight,
  DAY_PX,
  type DayPx,
  GANTT_CEILING_PX,
  GANTT_MIN_PX,
  ganttRoomInColumn,
} from './gantt-panel';
import { DEFAULT_SECTION_MODE, type SectionMode } from './plan-mermaid';
import type { PlanRenderer } from './plan-renderer';
import { linkPlanScroll } from './plan-scroll-link';
import {
  forgetGanttDayPx,
  forgetGanttHeight,
  forgetGanttLabels,
  forgetHiddenColumns,
  forgetWidthOverrides,
  rememberedExpansion,
  rememberedGanttDayPx,
  rememberedGanttHeight,
  rememberedGanttLabels,
  rememberedHiddenColumns,
  rememberedMermaidSectionMode,
  rememberedWidthOverrides,
  rememberExpansion,
  rememberGanttHeight,
  rememberLinksResetTarget,
  rememberWidthOverrides,
} from './remembered-layout';
import { clampColumnWidth, FLEXIBLE_FLOOR, type FrameLayoutState } from './table-frame';
import type { ChartRead } from './use-plan-read';
import { type TreeRow } from './wbs-rows';

/**
 * How wide a column is while its resize handle is `travel` px from where it was
 * grabbed.
 *
 * The whole of the arithmetic a drag writes, kept out of the handlers so that
 * something can hold it: jsdom performs no default action for a pointer event,
 * so the gesture is provable only in a browser (`e2e/layout.spec.ts`) and this
 * is the part that is not.
 *
 * `fromWidth` is the width the column was laid out at when the handle was taken
 * — not the width it is at now, which is this function's own answer one pointer
 * move ago.
 *
 * @throws {UnknownColumnError} through {@link clampColumnWidth}, for a column
 * with no declared width to drag. Nothing renders a handle on one.
 */
export function widthFromDrag(
  columnId: string,
  fromWidth: number,
  travel: number,
  state: FrameLayoutState,
): number {
  return clampColumnWidth(columnId, fromWidth + travel, state);
}

/** What a resize handle does with the width its gesture worked out. */
export interface ColumnResize {
  /** Follows the pointer: how wide the column is drawn while the drag is in flight. */
  drag: (columnId: string, width: number) => void;
  /** The width the reader let go at, which is the one that is remembered. */
  commit: (columnId: string, width: number) => void;
  /** A `pointercancel` — the browser took the gesture away — which leaves the widths as they were. */
  abandon: () => void;
}

/**
 * The grab handle on one column header's trailing edge.
 *
 * Hand-rolled `pointerdown`/`pointermove`/`pointerup` with pointer capture,
 * rather than TanStack's own column resizing: that writes the width into the
 * column definition, which is the one place in this table a width must never
 * live — `flexRender` renders each `cell` as a component *type*, so a
 * definition that changed with a width would remount every cell in the table on
 * every pointer move (LLM_README landmine #1).
 *
 * Capture is what makes the gesture survive the pointer leaving the 6px strip,
 * which it does immediately: with it, every `pointermove` and the `pointerup`
 * are delivered here however far away they happen.
 *
 * The width the drag counts from is taken **once**, at `pointerdown`. Counting
 * from the width on screen would compound this function's own answer with every
 * move — a drag that accelerates away from the pointer.
 *
 * For the one column that resolves no width — an undragged Name — the
 * from-width is the header cell's **rendered** width, measured at
 * `pointerdown`: the only measurement in the gesture, because there is no
 * resolved number to count from and the browser is the only thing that knows
 * what the remainder-absorber is standing at. jsdom lays nothing out and
 * measures every box at 0, so a zero falls back to the column's
 * `FLEXIBLE_FLOOR`; the real from-width is provable only in Chromium
 * (`e2e/layout.spec.ts`), the same bargain {@link GanttHeightHandle} makes.
 */
export function ColumnResizeHandle({
  columnId,
  heading,
  width,
  state,
  resize,
}: {
  columnId: string;
  /** What the column is called, so the control has a name to be found by. */
  heading: string;
  /**
   * The width the column resolves to now, which a new gesture starts from —
   * or `undefined` for an undragged flexible column, whose gesture starts
   * from the rendered width instead.
   */
  width: number | undefined;
  state: FrameLayoutState;
  resize: ColumnResize;
}) {
  const grabbed = useRef<{ pointerId: number; fromX: number; fromWidth: number } | null>(null);
  const widthAt = (clientX: number, from: { fromX: number; fromWidth: number }): number =>
    widthFromDrag(columnId, from.fromWidth, clientX - from.fromX, state);

  return (
    <span
      data-resize-handle={columnId}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${heading}`}
      data-hint={`Drag to resize ${heading}`}
      onPointerDown={(event) => {
        // The browser's own answer to a press and a drag across a heading is a
        // text selection, and there is nothing in this strip to select.
        event.preventDefault();
        // Capture, so every move and the release are delivered here however far
        // the pointer has travelled — a 6px strip is not something a hand stays
        // inside.
        event.currentTarget.setPointerCapture(event.pointerId);
        const cell = event.currentTarget.closest('th');
        // The strip is rendered inside the header cell it resizes; a handle
        // with no cell above it is an invariant broken, not a state to
        // default.
        if (cell === null) throw new Error('no header cell above the resize handle');
        const measured = cell.getBoundingClientRect().width;
        grabbed.current = {
          pointerId: event.pointerId,
          fromX: event.clientX,
          fromWidth: width ?? (measured > 0 ? measured : FLEXIBLE_FLOOR),
        };
      }}
      onPointerMove={(event) => {
        const from = grabbed.current;
        // A move with no grab behind it is the pointer crossing the strip, and
        // a second pointer's move is somebody else's gesture: neither is this
        // drag.
        if (from?.pointerId !== event.pointerId) return;
        resize.drag(columnId, widthAt(event.clientX, from));
      }}
      onPointerUp={(event) => {
        const from = grabbed.current;
        if (from?.pointerId !== event.pointerId) return;
        grabbed.current = null;
        resize.commit(columnId, widthAt(event.clientX, from));
      }}
      onPointerCancel={() => {
        if (grabbed.current === null) return;
        grabbed.current = null;
        resize.abandon();
      }}
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        width: 6,
        cursor: 'col-resize',
        // Or the frame under it takes a touch drag as a scroll and the column
        // never moves.
        touchAction: 'none',
        userSelect: 'none',
      }}
    />
  );
}

/** What the handle on the Gantt panel's top edge does with the height its gesture works out. */
export interface GanttHeightResize {
  /** Follows the pointer: how tall the panel is drawn while the drag is in flight. */
  drag: (heightPx: number) => void;
  /** The height the reader let go at, which is the one that is remembered. */
  commit: (heightPx: number) => void;
  /** A `pointercancel` — the browser took the gesture away — which leaves the height as it was. */
  abandon: () => void;
}

/**
 * The grab handle on the Gantt panel's top edge: dragging it up gives the
 * chart more of the screen, dragging it down gives it back to the plan.
 *
 * {@link ColumnResizeHandle}'s shape turned on its side — pointer capture, the
 * from-height taken **once** at `pointerdown`, the write held back to the
 * release — and rendered by the shell **outside** {@link GanttFaultBoundary}
 * on purpose: a chart that cannot be drawn costs the reader the chart, and
 * must not cost them the edge that gives it its screen back.
 *
 * The height a new gesture counts from is the panel as the browser really laid
 * it out — the override may be CSS-capped on a smaller screen than it was
 * dragged on, and counting from the stored number would open every such
 * gesture with a jump. jsdom lays nothing out and measures every box at 0, so
 * a zero falls back to the override, then to the floor; the real from-height
 * is provable only in Chromium (`e2e/gantt.spec.ts`).
 *
 * **The room the gesture may spend is measured the same way and at the same
 * moment** ({@link ganttRoomInColumn}), from the column this handle is a child
 * of. Once per gesture rather than per move, for the from-height's reason: both
 * ends of the sum are read off one layout, so a drag cannot be clamped against
 * a column measured mid-flight against a panel that is already following the
 * pointer.
 */
export function GanttHeightHandle({
  heightPx,
  resize,
}: {
  /** The override in force, or `null` while the panel stands at its default share. */
  heightPx: number | null;
  resize: GanttHeightResize;
}) {
  const grabbed = useRef<{
    pointerId: number;
    fromY: number;
    fromHeight: number;
    roomPx: number;
  } | null>(null);
  const heightAt = (clientY: number, from: { fromY: number; fromHeight: number; roomPx: number }) =>
    clampedGanttHeight(from.fromHeight + (from.fromY - clientY), from.roomPx);

  return (
    <div
      data-gantt-height-handle
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the Gantt chart"
      data-hint="Drag to resize the Gantt chart"
      onPointerDown={(event) => {
        // The browser's own answer to a press and a drag across the page is a
        // text selection, and there is nothing in this strip to select.
        event.preventDefault();
        // Capture, for {@link ColumnResizeHandle}'s reason: a hand does not
        // stay inside a 6px strip.
        event.currentTarget.setPointerCapture(event.pointerId);
        const panel = event.currentTarget.nextElementSibling;
        // The panel, or the fault standing in for it — either way the box this
        // gesture resizes. Absent means the handle was mounted without one,
        // which is an invariant broken, not a state to default.
        if (!(panel instanceof HTMLElement)) throw new Error('no chart under the height handle');
        const column = event.currentTarget.parentElement;
        // The plan's flex column, which is the box this gesture is bounded by.
        // Absent means the handle was mounted outside it, an invariant broken
        // rather than a state to default.
        if (column === null) throw new Error('no column around the height handle');
        const measured = panel.getBoundingClientRect().height;
        const room = ganttRoomInColumn(column, panel);
        grabbed.current = {
          pointerId: event.pointerId,
          fromY: event.clientY,
          fromHeight: measured > 0 ? measured : (heightPx ?? GANTT_MIN_PX),
          // `null` is a column nothing has laid out — jsdom, and only jsdom.
          // Falling back to the ceiling alone keeps those cases about the wiring
          // they can actually see (the height following the pointer, the commit,
          // the fallback) and leaves the room itself to Chromium, which is the
          // only thing that can measure it. A **zero** room is a real answer and
          // is not caught here: the floor in `clampedGanttHeight` wins over it,
          // which is what the spec asks for.
          //
          // Proof: with the fallback taken out — `roomPx: room ?? 0` — `follows
          // the pointer while dragged, and remembers where it was let go` failed
          // on `expected '84px' to be '450px'`, every jsdom drag clamped to the
          // floor by a column jsdom never laid out. Watched 2026-08-29.
          roomPx: room ?? GANTT_CEILING_PX,
        };
      }}
      onPointerMove={(event) => {
        const from = grabbed.current;
        // A move with no grab behind it is the pointer crossing the strip, and
        // a second pointer's move is somebody else's gesture: neither is this
        // drag.
        if (from?.pointerId !== event.pointerId) return;
        resize.drag(heightAt(event.clientY, from));
      }}
      onPointerUp={(event) => {
        const from = grabbed.current;
        if (from?.pointerId !== event.pointerId) return;
        grabbed.current = null;
        resize.commit(heightAt(event.clientY, from));
      }}
      onPointerCancel={() => {
        if (grabbed.current === null) return;
        grabbed.current = null;
        resize.abandon();
      }}
      className="shrink-0"
      style={{
        height: 6,
        // Pulled over the panel's own top border so the grab strip and the
        // drawn edge are one line, not a gap above it.
        marginBottom: -6,
        position: 'relative',
        zIndex: 1,
        cursor: 'row-resize',
        // Or the frame under it takes a touch drag as a scroll and the
        // boundary never moves.
        touchAction: 'none',
        userSelect: 'none',
      }}
    />
  );
}

/** Coordinates the table’s plan layout state and actions. */
export function useRememberedPlanLayout({ projectId }: { projectId: string }) {
  /**
   * Which branches are open, as this browser last left them for this project.
   *
   * Read straight into the initial state rather than in an effect: an effect
   * would render the default first and collapse the tree a frame later, which
   * is the plan visibly rearranging itself under the reader on every load.
   */
  const [expanded, setExpanded] = useState<ExpandedState>(() => rememberedExpansion(projectId));

  /** Which project the expansion above belongs to, so a save cannot pair it with another. */
  const expansionProject = useRef(projectId);

  /**
   * Saves every change to the expansion, and swaps it whole for another
   * project's.
   *
   * The two are one effect because they are one rule: the state and the key it
   * is written under must always name the same project. Switching project
   * re-reads first and saves nothing — this component is not remounted between
   * projects (`project-page.tsx` renders it without a `key`), so without the
   * swap the first save after a switch would stamp the old project's collapsed
   * branches onto the new project's key.
   */
  useEffect(() => {
    if (expansionProject.current !== projectId) {
      expansionProject.current = projectId;
      setExpanded(rememberedExpansion(projectId));
      return;
    }
    // Proof: removed, `remembers a collapsed branch across a remount` failed
    // with the branch open again, and `drops a remembered expansion that is
    // not one` failed with the hand-edited value still in storage. Watched,
    // 2026-08-06.
    rememberExpansion(projectId, expanded);
  }, [projectId, expanded]);

  /**
   * How wide this browser has dragged this project's columns, by column id.
   *
   * Beside the expansion and **not** in the `columns` memo, which is the whole
   * of where this state is allowed to live: it reaches the layout through
   * {@link frameState} below, and a column definition that changed with a width
   * would remount every cell in the table (landmine #1).
   *
   * Read straight into the initial state for {@link rememberedExpansion}'s
   * reason: an effect would lay the table out at its defaults and move every
   * column one frame later.
   */
  const [widthOverrides, setWidthOverrides] = useState<Map<string, number>>(() =>
    rememberedWidthOverrides(projectId),
  );

  /** Which project the widths above belong to, so a save cannot pair them with another. */
  const widthProject = useRef(projectId);

  /**
   * The Gantt panel's dragged height, or `null` while this project's panel has
   * never been dragged — which is the bounded default share, not a number.
   *
   * Read straight into the initial state for {@link widthOverrides}'s reason:
   * an effect would open the chart at its default and move it a frame later.
   */
  const [ganttHeightPx, setGanttHeightPx] = useState<number | null>(() =>
    rememberedGanttHeight(projectId),
  );

  /**
   * The plan's flex column — the box the chart panel is bounded by, and the
   * only thing that can say how much room it has.
   */
  const ganttColumn = useRef<HTMLElement | null>(null);

  /**
   * How much room that column has for the panel right now, or `null` where
   * nothing has measured it — the chart closed, and every jsdom render, which
   * lays nothing out.
   *
   * Held as state rather than read at paint because it decides what is drawn:
   * {@link ganttHeightPx} is the reader's *claim* and this is the authority on
   * what that claim means in the column it is being drawn in today. The claim
   * is never rewritten from here — a height dragged in a tall window comes back
   * in full when the window does, which it could not if a re-clamp had stored
   * itself over the top of it.
   */
  const [ganttRoomPx, setGanttRoomPx] = useState<number | null>(null);

  /**
   * The day scale in force, and {@link DAY_PX} where this browser has never
   * picked one for this project.
   *
   * A resolved rung rather than `DayPx | null`, which is where it parts from
   * {@link ganttHeightPx} beside it: a height of `null` is a real state — the
   * bounded default share, which is CSS and not a number — while there is no
   * such thing as a chart drawn at no scale. What "never picked" buys is
   * {@link resetLayout}'s answer, and that is `DAY_PX` either way.
   */
  const [ganttDayPx, setGanttDayPx] = useState<DayPx>(
    () => rememberedGanttDayPx(projectId) ?? DAY_PX,
  );

  /**
   * Whether the chart draws its row-name column, and `true` where this browser
   * has never said for this project.
   *
   * Resolved rather than `boolean | null` for {@link ganttDayPx}'s reason:
   * there is no such thing as a chart drawn with the names in neither state,
   * and what "never said" buys is {@link resetLayout}'s answer, which is `true`
   * either way.
   */
  const [ganttLabelsShown, setGanttLabelsShown] = useState<boolean>(
    () => rememberedGanttLabels(projectId) ?? true,
  );

  /**
   * What the two Mermaid exports group their bars into sections by, and
   * {@link DEFAULT_SECTION_MODE} where this browser has never picked.
   *
   * Resolved rather than `SectionMode | null` for {@link ganttLabelsShown}'s
   * reason: there is no such thing as a fence written with its `section` lines
   * in no grouping at all.
   *
   * Not swapped by the project effect below, unlike the four layout answers
   * there: {@link MERMAID_SECTION_MODE_KEY} is one key for the browser, so
   * there is nothing per project to swap in.
   */
  const [mermaidSectionMode, setMermaidSectionMode] = useState<SectionMode>(
    () => rememberedMermaidSectionMode() ?? DEFAULT_SECTION_MODE,
  );
  return {
    expanded,
    setExpanded,
    widthOverrides,
    setWidthOverrides,
    widthProject,
    ganttHeightPx,
    setGanttHeightPx,
    ganttColumn,
    ganttRoomPx,
    setGanttRoomPx,
    ganttDayPx,
    setGanttDayPx,
    ganttLabelsShown,
    setGanttLabelsShown,
    mermaidSectionMode,
    setMermaidSectionMode,
  };
}

/** Coordinates the table’s plan layout state and actions. */
export function usePlanLayoutSwap({
  widthProject,
  projectId,
  setWidthOverrides,
  setStoredHiddenColumns,
  setGanttHeightPx,
  setGanttDayPx,
  setGanttLabelsShown,
}: {
  widthProject: React.MutableRefObject<string>;
  projectId: string;
  setWidthOverrides: React.Dispatch<React.SetStateAction<Map<string, number>>>;
  setStoredHiddenColumns: React.Dispatch<React.SetStateAction<readonly string[]>>;
  setGanttHeightPx: React.Dispatch<React.SetStateAction<number | null>>;
  setGanttDayPx: React.Dispatch<React.SetStateAction<4 | 12 | 28>>;
  setGanttLabelsShown: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  /**
   * Swaps the widths and the panel height whole when the project does.
   *
   * Not the expansion's effect, and not paired with a save: nothing is written
   * here at all. Both are written when a drag is let go of and when the
   * reset is pressed, so there is no first-save-after-a-switch to guard against
   * — only the read, which would otherwise leave one project's layout laid out
   * over another's.
   */
  useEffect(() => {
    if (widthProject.current === projectId) return;
    widthProject.current = projectId;
    setWidthOverrides(rememberedWidthOverrides(projectId));
    setStoredHiddenColumns(rememberedHiddenColumns(projectId));
    setGanttHeightPx(rememberedGanttHeight(projectId));
    setGanttDayPx(rememberedGanttDayPx(projectId) ?? DAY_PX);
    setGanttLabelsShown(rememberedGanttLabels(projectId) ?? true);
  }, [
    projectId,
    setGanttDayPx,
    setGanttHeightPx,
    setGanttLabelsShown,
    setStoredHiddenColumns,
    setWidthOverrides,
    widthProject,
  ]);
  return {};
}

/** Coordinates the table’s plan layout state and actions. */
export function usePlanLayoutEffects({
  frameRef,
  ganttOpen,
  renderer,
  chartRead,
  ganttColumn,
  setGanttRoomPx,
}: {
  frameRef: React.MutableRefObject<HTMLDivElement | null>;
  ganttOpen: boolean;
  renderer: PlanRenderer;
  chartRead: ChartRead;
  ganttColumn: React.MutableRefObject<HTMLElement | null>;
  setGanttRoomPx: React.Dispatch<React.SetStateAction<number | null>>;
}) {
  /**
   * Holds the plan's two faces on one row while both are on screen.
   *
   * Installed from here rather than from either face, because neither face owns
   * the other and this component owns both. The panel is found by the attribute
   * the gate already knows it by rather than by a ref threaded through
   * `GanttFaultBoundary` — the boundary may have unmounted the panel by the
   * time this runs, which is a state the query answers `null` for and a ref
   * would answer `null` for too, at the cost of a prop on a component this
   * change otherwise does not touch.
   *
   * `generation` is a dependency for that boundary: a chart that faulted and
   * was reset is a new panel element, and a link left holding the old one would
   * listen to a node nothing scrolls. The renderer is one because the outline
   * cards have no frame to link — `frameRef` is `null` under them, and the
   * effect re-runs to say so when a rotation swaps the renderer.
   */
  useEffect(() => {
    const frame = frameRef.current;
    if (frame === null || !ganttOpen) return;
    const panel = document.querySelector<HTMLElement>('[data-gantt-panel]');
    if (panel === null) return;
    // A panel is not always a chart. A plan whose dependencies run in a circle
    // draws the sentence about it under this same attribute
    // (`gantt-panel.tsx`), and that section has no calendar axis and no rows to
    // pair — `panelFace` refuses an element it cannot measure, and it would do
    // it inside a scroll listener, where no boundary of ours is: every scroll
    // of the frame would throw for as long as the circle stood. Found in
    // cross-review, 2026-08-12; `wbs-table.test.tsx` holds it.
    //
    // Read off the axis rather than off `scheduleError` because the axis is
    // exactly what the link needs — a panel that is a message of any other kind
    // is as unusable, and would not have to be remembered here. The dependency
    // list already covers the swap: `scheduleError` is set on the same read as
    // `chartRead` below, so a read that lands or clears a circle brings a new
    // `generation` with it.
    if (panel.querySelector('[data-gantt-axis]') === null) return;
    return linkPlanScroll(frame, panel);
  }, [ganttOpen, renderer, chartRead.generation, frameRef]);

  /**
   * Keeps {@link ganttRoomPx} on what the column really has, so a remembered
   * height is drawn against today's window rather than the one it was dragged
   * in.
   *
   * A layout effect, before the browser paints: measuring after the paint would
   * show the unclamped height for a frame and then snatch it back.
   *
   * The panel is found through the handle rather than by `[data-gantt-panel]`,
   * so the measurement is of whatever box sits under the handle — the chart,
   * the cycle message, or {@link GanttFaultBoundary}'s stand-in. It is the same
   * rule the handle itself uses at `pointerdown`, and the two agreeing is what
   * makes a drag land where the re-clamp would have put it.
   *
   * **No loop, and that is a property of what is measured, not of a guard**:
   * {@link ganttRoomInColumn} is invariant under the panel's own height, so the
   * observer's answer after a re-clamp is the answer it gave before it, and
   * React drops the identical state.
   *
   * **Every child is observed as well as the column, because a child can change
   * height without the column changing size at all.** The column is `flex-1` in
   * a page that is exactly the window tall, so its own box is fixed while the
   * window is: measured in Chromium at 768x900, committing a drag puts `Reset
   * layout` on the toolbar, that takes the toolbar from one row to two, and an
   * observer watching only the column never hears about it — the room stays at
   * the 425 taken at `pointerdown` and the panel's bottom lands 12px below the
   * column's. Observing the panel too costs nothing and loops on nothing, for
   * the reason above: the room does not depend on the panel's own height.
   *
   * `ResizeObserver` is absent in jsdom, where every box measures 0 and there
   * is nothing to observe anyway; the room stays `null` there and the claim is
   * drawn unclamped. Chromium is the oracle (`e2e/gantt.spec.ts`).
   */
  useLayoutEffect(() => {
    const column = ganttColumn.current;
    if (column === null || !ganttOpen) {
      setGanttRoomPx(null);
      return;
    }
    const measure = (): void => {
      const panel = column.querySelector('[data-gantt-height-handle]')?.nextElementSibling;
      if (!(panel instanceof HTMLElement)) return;
      setGanttRoomPx(ganttRoomInColumn(column, panel));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const watchColumn = new ResizeObserver(measure);
    watchColumn.observe(column);
    // Proof: with this loop deleted — the column alone observed, which is what
    // shipped — `re-measures the room when the toolbar wraps under a new
    // control` failed on `the chart is drawn past the bottom of its column
    // after the toolbar wrapped · Expected: <= 893 · Received: 904`. Watched in
    // Chromium at 768x900, 2026-08-30.
    for (const child of column.children) watchColumn.observe(child);
    return () => {
      watchColumn.disconnect();
    };
  }, [ganttOpen, renderer, chartRead.generation, ganttColumn, setGanttRoomPx]);
  return {};
}

/** Coordinates the table’s plan layout state and actions. */
export function usePlanLayout({
  flat,
  widthOverrides,
  setWidthOverrides,
  projectId,
  setGanttHeightPx,
  setGanttDayPx,
  setGanttLabelsShown,
  setStoredHiddenColumns,
  resetTargetHiddenColumnIds,
  hasAnyExternalRefs,
  hiddenColumnIds,
}: {
  flat: TreeRow[];
  widthOverrides: Map<string, number>;
  setWidthOverrides: React.Dispatch<React.SetStateAction<Map<string, number>>>;
  projectId: string;
  setGanttHeightPx: React.Dispatch<React.SetStateAction<number | null>>;
  setGanttDayPx: React.Dispatch<React.SetStateAction<4 | 12 | 28>>;
  setGanttLabelsShown: React.Dispatch<React.SetStateAction<boolean>>;
  setStoredHiddenColumns: React.Dispatch<React.SetStateAction<readonly string[]>>;
  resetTargetHiddenColumnIds: readonly string[];
  hasAnyExternalRefs: boolean;
  hiddenColumnIds: string[];
}) {
  /**
   * Every fact about this plan that a column's width is allowed to depend on.
   *
   * `flat` rather than the rows on screen, and that is the whole point of the
   * question being asked this way: it is every row in the **project**, open or
   * collapsed, matched by a search or narrowed out of it. A column that got
   * narrower because the one row with a day on it was collapsed away would
   * change width under a reader who was only scrolling.
   */
  const frameState: FrameLayoutState = {
    hasAnyNotBefore: flat.some((row) => row.startNoEarlierThan !== null),
    // The reader's own answer, which outranks whatever the fact above resolves
    // to. Built here rather than passed to each consumer, so the `<colgroup>`,
    // both minimums and the pinned offsets cannot be answers to two different
    // questions.
    columnWidthOverrides: widthOverrides,
  };

  /** What the resize handles on the heading row do with the widths they work out. */
  const resizeColumn: ColumnResize = {
    drag: (columnId, width) => {
      // Per move, so the column follows the pointer. Only the write below is
      // held back to the end of the gesture.
      setWidthOverrides((current) => new Map(current).set(columnId, width));
    },
    commit: (columnId, width) => {
      const committed = new Map(widthOverrides).set(columnId, width);
      setWidthOverrides(committed);
      rememberWidthOverrides(projectId, committed);
    },
    abandon: () => {
      // A `pointercancel` is the browser taking the gesture — a system gesture,
      // a lost device — and what it leaves behind is the last width this
      // render saw rather than a half-finished one. Re-read from storage
      // rather than remembered in a ref: the storage is the last committed
      // answer by construction.
      setWidthOverrides(rememberedWidthOverrides(projectId));
    },
  };

  /** What the handle on the Gantt panel's top edge does with the heights its gestures work out. */
  const resizeGantt: GanttHeightResize = {
    drag: (heightPx) => {
      // Per move, so the boundary follows the pointer. Only the write below is
      // held back to the end of the gesture.
      setGanttHeightPx(heightPx);
    },
    commit: (heightPx) => {
      setGanttHeightPx(heightPx);
      rememberGanttHeight(projectId, heightPx);
    },
    abandon: () => {
      // Re-read from storage rather than remembered in a ref, for
      // {@link resizeColumn}'s reason: the storage is the last committed
      // answer by construction.
      setGanttHeightPx(rememberedGanttHeight(projectId));
    },
  };

  /**
   * Forgets the Gantt's own settings for this project — the dragged panel
   * height, the picked day scale and the hidden row-name labels — so each
   * returns to what is resolved for it **now**: the panel to its default
   * share, the scale back to {@link DAY_PX} (Days), the labels to shown.
   *
   * The width half of a layout reset stays in {@link resetLayout}, which
   * delegates here: a phone card has a chart height, a scale and row names
   * but no columns to widen, so this half is the one the Plan actions sheet
   * carries, and a width override is nothing a card can forget.
   *
   * Forgotten, never frozen — storing any of the three as it stands would
   * turn a reset into a rename of today's defaults.
   */
  function resetGanttSettings(): void {
    setGanttHeightPx(null);
    forgetGanttHeight(projectId);
    setGanttDayPx(DAY_PX);
    forgetGanttDayPx(projectId);
    setGanttLabelsShown(true);
    forgetGanttLabels(projectId);
  }

  /**
   * Forgets the column widths, the hidden columns **and** the Gantt settings
   * for this project, so each returns to what is resolved for it **now** — the
   * widths to the frame layout's answer, the columns on screen to the default
   * column set, the chart to its default share, the scale to Days, the labels
   * to shown.
   *
   * Forgotten, never frozen. Storing either half as it stands would turn a
   * reset into a rename of today's defaults, and a column whose default had
   * moved since — `not-before` is 56px or 84px — would come back to the wrong
   * one.
   *
   * Proof: the height half deleted, `one reset forgets the widths and the
   * height together` (wbs-table.test.tsx) failed on `expected '500' to be
   * null` — the widths forgotten, the chart still holding its dragged share.
   * Watched, 2026-08-10.
   */
  function resetLayout(): void {
    setWidthOverrides(new Map());
    forgetWidthOverrides(projectId);
    setStoredHiddenColumns(resetTargetHiddenColumnIds);
    forgetHiddenColumns(projectId);
    rememberLinksResetTarget(projectId, hasAnyExternalRefs);
    resetGanttSettings();
  }

  /**
   * Whether the columns on screen are not the default column set — a column
   * hidden, or a default-hidden one shown — which is the columns half of
   * whether `Reset layout` has anything to do. Compared as sets: the order a
   * reader ticked things in is not a difference.
   */
  const columnsDiffer =
    hiddenColumnIds.length !== resetTargetHiddenColumnIds.length ||
    hiddenColumnIds.some((id) => !resetTargetHiddenColumnIds.includes(id));
  return { frameState, resizeColumn, resizeGantt, resetGanttSettings, resetLayout, columnsDiffer };
}
