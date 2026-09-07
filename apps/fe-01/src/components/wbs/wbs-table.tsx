import { flexRender, useTable } from '@tanstack/react-table';
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import { Button } from '@/components/ui/button';

import { type ColumnHintState, hintFor } from './column-hints';
import { createDepLights, type DepLights } from './dep-light-store';
import { type DropZone, zoneFor } from './drag-drop';
import { cellKey } from './editable-grid';
import { ExternalRefsModal } from './external-refs-modal';
import { GanttFaultBoundary } from './gantt-fault';
import { appliedGanttHeight, DAY_PX, GanttPanel } from './gantt-panel';
import { KeyboardCheatSheet } from './keyboard-cheat-sheet';
import { OptimizationIndicator } from './optimization-indicator';
import { PlanCards } from './plan-cards';
import { createPlanCellProps, opensAPopover } from './plan-cell-props';
import { usePlanChartInput, usePlanSchedule } from './plan-chart-input';
import { PLAN_TABLE_FEATURES } from './plan-columns/column';
import { createPlanColumns } from './plan-columns/columns';
import { usePlanExportActions, usePlanOnScreenExport } from './plan-export-actions';
import type { PlanLiveValues } from './plan-live';
import { showDay } from './plan-number-format';
import { useRendererForViewport } from './plan-renderer';
import { PlanToolbar } from './plan-toolbar';
import { PlanToolbarSheet } from './plan-toolbar-sheet';
import { createPointedRows, type PointedRows } from './pointed-row-store';
import { rememberGanttDayPx, rememberGanttLabels } from './remembered-layout';
import {
  CELL,
  flexibleCellStyle,
  frameLayout,
  GANTT_DOCK_SLACK,
  pinnedCellStyle,
  POPOVER_ROW_LAYER,
  resetHiddenColumns,
  STICKY_HEADER_CELL,
  TABLE_FRAME,
  tableWidthStyle,
} from './table-frame';
import { ToastStack, useToasts } from './toasts';
import { useColumnSet } from './use-column-set';
import {
  useEstimateDrafts,
  useEstimateDraftState,
  useEstimateMentions,
} from './use-estimate-drafts';
import { usePlanDependencies } from './use-plan-dependencies';
import { usePlanFields } from './use-plan-fields';
import { usePlanFilter, usePlanFilterState } from './use-plan-filter';
import {
  ARMED_TINT,
  usePlanKeyboard,
  usePlanKeyboardEffects,
  usePlanKeyboardState,
  usePlanReadiness,
  useRowNavigation,
} from './use-plan-keyboard';
import {
  ColumnResizeHandle,
  GanttHeightHandle,
  usePlanLayout,
  usePlanLayoutEffects,
  usePlanLayoutSwap,
  useRememberedPlanLayout,
} from './use-plan-layout';
import type { WbsTableProps } from './use-plan-read';
import { usePlanRead, usePlanReadState } from './use-plan-read';
import {
  useAddWorkItem,
  usePlanDragState,
  usePlanStructure,
  usePlanStructureEffects,
} from './use-plan-structure';
import { usePlanAssignments, usePlanLabels, useReferenceSets } from './use-reference-sets';
import { type TreeRow } from './wbs-rows';

/** What {@link PlanRow} needs beyond the cells it is handed. */
interface PlanRowProps {
  rowId: string;
  frozen: boolean;
  /**
   * Where this row's **dependency** light is read from.
   *
   * Subscribed to rather than handed in as a boolean since 2026-09-02: it was a
   * prop derived per render of the whole table, so pointing at one chip
   * re-rendered every row and the chart to move a tint that lands on two. The
   * tint itself lands on the cells through the `--cell-bg` join (`styles.css`),
   * never on the `<tr>`, for `data-armed`'s reason: a pinned cell paints its
   * own opaque background and would cover a colour set here.
   */
  depLights: DepLights;
  /**
   * The armed row, said on the row rather than only in the toast: a sentence
   * in the corner of the screen is not where somebody looks to find out which
   * row a second Ctrl+D will take.
   */
  armed: boolean;
  /** The drop marker the last `dragover` worked out for this row, if any. */
  drop: DropZone | undefined;
  /** Where the row light is read from, and where the pointer's readings go. */
  pointed: PointedRows;
  onDragOver: ComponentProps<'tr'>['onDragOver'];
  onDragLeave: ComponentProps<'tr'>['onDragLeave'];
  onDrop: ComponentProps<'tr'>['onDrop'];
  /** The `<td>`s, rendered by {@link WbsTable} — see the shell's own JSDoc. */
  children: ReactNode;
}

/**
 * One plan row's `<tr>` shell: the row-level attributes, the pointer's
 * enter and leave, and the **row light** from its own subscription.
 *
 * A component of its own so the light can move without the table rendering.
 * {@link WbsTable}'s cells read their live state through its `live` ref and
 * rely on every parent render reaching every cell, so the pointed row must not
 * be that component's state — held there it cost a render of all ~500 cells
 * and the whole chart per row the pointer crossed (75–120ms each, measured in
 * Chromium, `pointed-row-render-cost`). The shell subscribes to
 * {@link PointedRows} for the one boolean it draws; when only that changes,
 * React re-renders this `<tr>` and **bails on the unchanged cell elements**
 * handed in as `children`, so moving the light renders two shells and not one
 * cell. The cells stay the parent's render exactly so their `live` contract is
 * untouched — this is deliberately not `memo`, which would have to enumerate
 * everything a cell reads and would go silently stale on the first miss.
 *
 * `data-row-lit` says this is the **pointed row**, whichever face pointed it:
 * a bar or a row's line on the chart, a bar's focus, or the pointer resting on
 * this row here. Writing it on the hovered row itself makes
 * `tr:not([data-row-lit])…:nth-child(even):hover` unmatchable — deliberately,
 * since `pointed-row-one-ink`: one ink for the row you are asking about, and
 * the alternating stripe left to say only which row is which at rest (Dany,
 * 2026-09-01: "highlighted row is colored independently of which odd or even
 * row this is"). A **second attribute** beside `data-dep-lit` rather than a
 * reuse of it: the two share the tint and not the meaning, and `data-dep-lit`
 * is read by tests and by a reader as "some Depends on cell waits for this
 * row", which a bar's hover would make untrue.
 *
 * Enter and leave, not over and out: a pointer moving from one `<td>` of this
 * row to the next fires `pointerout` on the first, and reading that as a
 * departure would clear the light halfway across the row it is meant to be
 * on. React synthesizes these two from over/out and decides "left" from where
 * the pointer went, which is the question being asked.
 *
 * Proof of the address: the store's writes routed back through a `WbsTable`
 * `useState`, and `pointing a row from the chart re-renders no unrelated row`
 * failed on `expected 7 to be less than or equal to 4` — every row's cells
 * rendered for a light that touched two. Watched 2026-09-01.
 */
function PlanRow({
  rowId,
  frozen,
  depLights,
  armed,
  drop,
  pointed,
  onDragOver,
  onDragLeave,
  onDrop,
  children,
}: PlanRowProps) {
  const lit = useSyncExternalStore(pointed.subscribe, () => pointed.pointedAt() === rowId);
  const depLit = useSyncExternalStore(depLights.subscribe, () => depLights.isLit(rowId));
  return (
    <tr
      // The row's identity, on the row — the handle the browser proofs find a
      // dependency's `<tr>` by (precedent: `data-armed`, `data-drop`), and the
      // shell's own subscription key. Nothing else in the app reads it.
      data-row-id={rowId}
      data-frozen={frozen ? 'true' : 'false'}
      data-dep-lit={depLit ? 'true' : undefined}
      data-row-lit={lit ? 'true' : undefined}
      data-armed={armed ? 'true' : undefined}
      data-drop={drop}
      onPointerEnter={(pointer) => {
        // **The touch seam.** Chromium synthesizes a whole mouse sequence from
        // a tap, so a row lit on a mouse event lights on every tap as well —
        // and a tap has no departure behind it, so the light would then be
        // stuck on whatever was touched last. The bar's own `onPointerOver`
        // carries this guard for the same reason.
        if (pointer.pointerType !== 'mouse') return;
        pointed.pointTable(rowId);
      }}
      onPointerLeave={(pointer) => {
        if (pointer.pointerType !== 'mouse') return;
        // The store clears this only if the row is still the pointed one: a
        // departure from a row the pointer has already left — the order the
        // events arrive in when it moves straight to the next row — must not
        // clear the light the arrival just set. See {@link PointedRows}.
        pointed.leaveTable(rowId);
      }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {children}
    </tr>
  );
}

/**
 * The work breakdown: one grid that is a table and a nested list at once.
 *
 * TanStack Table owns exactly one thing here — which branches are open. Ordering
 * is not its job: be-01 returns rows already in the order they read, because the
 * numbering is built so a single lexicographic sort produces tree order across
 * every level. Sorting them again on the client would be a second implementation
 * of that, and the two would eventually disagree.
 *
 * Every edit is a request and the tree is refetched, never patched locally. A
 * create or a move can renumber rows this component never touched, and guessing
 * which would be a second implementation of the derivation as well.
 */
export function WbsTable({
  projectId,
  projectName,
  api,
  subscribe,
  savedPlansShelf,
}: WbsTableProps) {
  const {
    activeProject,
    workItems,
    setWorkItems,
    treeReadProject,
    chartRead,
    setChartRead,
    steps,
    setSteps,
    treeMayBeStale,
    setTreeMayBeStale,
    markers,
    setMarkers,
    busy,
    setBusy,
    connected,
    setConnected,
    scheduleError,
    setScheduleError,
    estimateMethod,
    setEstimateMethod,
    stack,
    setStack,
    startDate,
    setStartDate,
    teams,
    setTeams,
    tags,
    setTags,
    services,
    setServices,
    workItemTypes,
    setWorkItemTypes,
    externalSystems,
    setExternalSystems,
    teamCapacities,
    setTeamCapacities,
    priorityBands,
    setPriorityBands,
    people,
    setPeople,
  } = usePlanReadState({ projectId });
  const {
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
  } = useRememberedPlanLayout({ projectId });
  const { query, setQuery, facets, setFacets, savedViews, setSavedViews } = usePlanFilterState({
    projectId,
  });
  /**
   * What happened, in the corner, one message per event.
   *
   * Events, not states: a request that was refused, a gesture that was
   * cancelled. The two banners below — the dependency cycle and the dropped
   * socket — are states, and they stay banners, because a state is true until
   * something changes it and a toast is a thing that happened once. See
   * {@link ToastStack}.
   */
  const { toasts, pushToast, dismissToast } = useToasts();
  const { drafts, setDrafts, mention, setMention, foldedBox, foldedAtFocus } =
    useEstimateDraftState();
  /**
   * The one cell whose hover card is open, as a {@link cellKey}, or null.
   *
   * One state for every surface that opens a card — the Name cell's notes
   * marker, a folded step's figure, the depends chips — rather than one state
   * each, and that is what makes "one card at a time" true by construction
   * rather than by three pieces of code remembering to close each other.
   *
   * Keyed by cell rather than by row because a row has several of them, and by
   * the `rowId::columnId` the keyboard grid already names cells with, so this
   * file holds one spelling of "which cell".
   *
   * Read through {@link live} inside `columns`, never closed over: `columns`
   * depends on `steps` alone, and a dependency that changed on every mouse
   * move would remount every cell in the table as the pointer crossed it.
   */
  const [hoveredCell, setHoveredCell] = useState<string | null>(null);
  /**
   * The one cell whose card is open because it has the **focus**, as a
   * {@link cellKey}, or null.
   *
   * A second state rather than a second writer of {@link hoveredCell}, and round
   * 4's finding 9 is why. The two are set and cleared by gestures that do not
   * take turns: a pointer wandering across any other cardable cell and off it
   * again ran the hover's guarded clear, and the still-focused cell was left
   * with no card and no reason to fire a focus event ever again — a description
   * that vanishes because a mouse went past.
   *
   * Not settled against a refreshed tree the way `hoveredCell` is, deliberately:
   * a card that belongs to the focus should follow the focus, and the browser
   * moves that with its element whatever the tree did. A row deleted while its
   * box was focused leaves a key here that no rendered cell can ever match
   * again, which shows nothing and is replaced by the next focus.
   */
  const [focusedCell, setFocusedCell] = useState<string | null>(null);
  /**
   * The one cell whose card is on screen: the pointer's while it is on
   * something, and the focus's when it is not.
   *
   * Derived rather than stored, which is what keeps "one card at a time" true by
   * construction now that two gestures can open one. The pointer wins because it
   * is the deliberate act of the moment — a reader who moves the mouse onto a
   * cell is asking about that cell — and the focus is still where they left it
   * when they move away again.
   */
  const openCard = hoveredCell ?? focusedCell;
  /**
   * Where every row sat as of the last tree read, by {@link placementsOf}.
   *
   * A ref because nothing renders it: it exists so the next read can be asked
   * whether the hovered row is still where the open card was drawn.
   */
  const rowPlacements = useRef<ReadonlyMap<string, string>>(new Map());
  const {
    cheatSheetOpen,
    setCheatSheetOpen,
    armedDelete,
    setArmedDelete,
    dReleased,
    commandInFlight,
    focusIntent,
    gapVisit,
    setGapVisit,
    gridElement,
  } = usePlanKeyboardState();
  const {
    unfoldedSteps,
    setStoredHiddenColumns,
    hiddenColumnIds,
    offeredColumns,
    toggleColumn,
    toggleStep,
  } = useColumnSet({ projectId, steps });
  usePlanLayoutSwap({
    widthProject,
    projectId,
    setWidthOverrides,
    setStoredHiddenColumns,
    setGanttHeightPx,
    setGanttDayPx,
    setGanttLabelsShown,
  });

  /**
   * The row whose links are being edited, or null while no editor is open.
   *
   * The row **id** and not the row: the modal is rendered from whatever the
   * current tree says about that id, so a peer's edit landing while the editor
   * is open redraws the list instead of leaving a stale copy on screen.
   */
  const [refsEditing, setRefsEditing] = useState<string | null>(null);
  const { dragging, setDragging, dropHint, setDropHint } = usePlanDragState();
  /**
   * The Depends on picker: which row's cell it is open under, what has been
   * typed into it, and which entry is highlighted — by the entry's id, never
   * an index. A peer edit can reshuffle the list under an open picker, and an
   * index would silently move the highlight to a row the user never aimed at;
   * an id follows its row, or disappears with it (cross review #6).
   *
   * `highlightId: null` means nothing is highlighted, and it matters at
   * Enter: an empty cell whose list happens to be showing must not add the
   * first entry on a stray Enter. Typing highlights the narrowed-to entry —
   * that is what the typing was for — and the arrows move it.
   */
  const [depPicker, setDepPicker] = useState<{
    rowId: string;
    typed: string;
    highlightId: string | null;
  } | null>(null);
  /**
   * Which rows a hovered or focused **Depends on** cell lights — the pointer's
   * reading, the keyboard's, and the resolution of the two. See
   * {@link createDepLights}, which owns all three and the proofs that guard
   * them.
   *
   * A **store** rather than two `useState`s since 2026-09-02, and the address
   * was the whole of the cost: the cells read their live state through
   * {@link live} and rely on every parent render reaching every cell, so a
   * pointer crossing one chip re-rendered every row, every cell and the chart
   * to move a tint that lands on two rows. Each `<tr>` shell subscribes for its
   * own light and an open card for its emphasis; `plan-dependencies.test.tsx`'s
   * `narrowing to a pill re-renders the row whose light moved and nothing else`
   * is what holds that, watched failing on `expected 4 to be less than or equal
   * to 2` with the writes routed back through state.
   *
   * Still read through {@link live} inside `columns`, and for the unchanged
   * reason `hoveredCell` is: a `columns` that depended on a pointer reading
   * would **remount** every cell on the first hover and take the focus with it.
   * `useRef` and not `useState` for the handle itself — the store is created
   * once and never replaced.
   */
  const depLights = useRef(createDepLights()).current;
  /**
   * The **pointed row** — three readings, one per place the answer can come
   * from — and the rule that each face lights the other face's.
   *
   * The plan is drawn twice and until these the two drawings said nothing about
   * each other: which of sixty rows a bar was *for* was a question a reader
   * answered by counting rows in a 176px label column. `linked-scroll` fixed
   * the coarse half — the two faces start on the same row — and this is the
   * per-row half. Both faces light from the one resolved answer: the `<tr>`
   * carries it as `data-row-lit` ({@link PlanRow}), the chart as its label
   * light and band.
   *
   * The readings are read on each `<tr>` and by the panel through their own
   * subscriptions, and **never** inside `columns`: that memo depends on
   * `steps` and `unfoldedSteps` and nothing else, and a dep added here would
   * hand every cell a new component type on the first hover and remount the
   * lot, taking the focus and any half-typed value with it (LLM_README
   * landmine #1).
   *
   * A store rather than three `useState`s since `pointed-row-render-cost`, and
   * the address is the whole point: the cells read their live state through
   * {@link live} and rely on every render of this component reaching every
   * cell, so a pointed row held here re-rendered all ~500 of them and the
   * whole chart per row the pointer crossed — 75–120ms each, measured. The
   * store renders only its subscribers: the two `<tr>` shells whose light
   * moved ({@link PlanRow}) and the chart shell. The three readings, their
   * precedence and the shown-row guard live in {@link createPointedRows}.
   *
   * Proof of the landmine: `chartPointedRow` added to the `columns` memo's
   * dependency list, and `points a row without remounting the cells under a
   * half-typed name` failed on `expected <textarea …(5)></textarea> to be
   * <textarea …(5)></textarea>` — the same-labelled box a different node, the
   * cell remounted under the typist. Watched 2026-08-14. Proof of the
   * address: the store's writes routed back through a `useState` here, and
   * `pointing a row from the chart re-renders no unrelated row` failed on
   * `expected 7 to be less than or equal to 4`. Watched 2026-09-01.
   */
  const [pointedRows] = useState(createPointedRows);
  /**
   * The row whose actions menu is open, or null while none is.
   *
   * One row id rather than a set, and that is the rule rather than a
   * simplification: two open menus are two `menuitem`s called `Duplicate`, and
   * an accessible name that matches several elements is ambiguous to a screen
   * reader and to a test alike. Read through {@link live} for the reason
   * `depPicker` is — `columns` must not depend on anything that changes on a
   * click, or every cell in the table remounts under the menu that was opened.
   */
  const [openMenuRowId, setOpenMenuRowId] = useState<string | null>(null);
  /**
   * Whether the toolbar's `Freeze #` menu is open.
   *
   * Its own flag rather than a place in {@link openMenuRowId}, because that one
   * answers "which **row**", and the freeze menu belongs to the plan. The two
   * may be open at once and no name collides when they are: the items here are
   * `Freeze numbering` and `Unfreeze all`, a row's are `Duplicate`, `Unfreeze`
   * and `Delete`.
   *
   * Not read by `columns` and it must not become so — landmine #1: a dependency
   * that changes on a click remounts every cell in the table.
   */
  const [freezeMenuOpen, setFreezeMenuOpen] = useState(false);
  /**
   * Which of the two renderers is drawing the plan.
   *
   * Whether the phone's toolbar sheet is **open** is no longer here — see
   * {@link PlanToolbarSheet}, which owns it so that opening a sheet does not
   * re-render the plan behind it. The effect that closed the sheet on every
   * renderer change went with it: only this renderer mounts the sheet, so a
   * window dragged wide unmounts it and there is nothing left to close.
   */
  const renderer = useRendererForViewport();
  /**
   * Whether the Gantt panel is under the plan.
   *
   * Off to begin with, and not remembered anywhere: the plan is the editor and
   * the chart is a second thing to look at, so a reader who opened it once on
   * one project has not asked for it on every project they open afterwards.
   */
  const [ganttOpen, setGanttOpen] = useState(false);

  /**
   * The frame the table scrolls inside, so the chart under it can be held on
   * the row the table is showing.
   *
   * The only thing this ref is for. Every other reader of the frame finds it by
   * `[data-table-frame]`, and so does the browser gate.
   */
  const frameRef = useRef<HTMLDivElement | null>(null);
  usePlanLayoutEffects({ frameRef, ganttOpen, renderer, chartRead, ganttColumn, setGanttRoomPx });
  const { refreshOrMarkStale, run, stepStack, runMarkerWrite } = usePlanRead({
    setDrafts,
    projectId,
    activeProject,
    api,
    setTreeMayBeStale,
    setMarkers,
    setTeams,
    setTags,
    setServices,
    setWorkItemTypes,
    setExternalSystems,
    setPeople,
    setWorkItems,
    treeReadProject,
    rowPlacements,
    setHoveredCell,
    setChartRead,
    setStack,
    setTeamCapacities,
    setPriorityBands,
    setScheduleError,
    setEstimateMethod,
    setStartDate,
    setSteps,
    pushToast,
    subscribe,
    setConnected,
    focusIntent,
    setBusy,
  });
  usePlanKeyboardEffects({
    setCheatSheetOpen,
    stepStack,
    armedDelete,
    pushToast,
    setArmedDelete,
    dismissToast,
    dReleased,
  });
  usePlanStructureEffects({
    setDragging,
    pushToast,
    setDropHint,
    workItems,
    focusIntent,
    gridElement,
  });

  /** Every row in the order the table renders them, ignoring collapse. */
  const flat = useMemo(() => {
    const out: TreeRow[] = [];
    const walk = (rows: readonly TreeRow[]): void => {
      for (const row of rows) {
        out.push(row);
        walk(row.subRows);
      }
    };
    walk(workItems);
    return out;
  }, [workItems]);

  const hasSuccessfulTreeRead = treeReadProject.current === projectId;
  const hasAnyExternalRefs = useMemo(() => flat.some((row) => row.externalRefs.length > 0), [flat]);
  const resetTargetHiddenColumnIds = resetHiddenColumns(hasAnyExternalRefs);

  /**
   * The row the ref editor is open on, or null while none is — including the
   * window after a peer (or this reader) deletes the row the editor stood on.
   *
   * Resolved from the current tree on every render rather than held: the modal
   * shows the list as it now stands, so a peer's write lands in an open editor
   * instead of being overwritten by a copy taken when it opened.
   */
  const refsEditingRow = useMemo(
    () => (refsEditing === null ? null : (flat.find((row) => row.id === refsEditing) ?? null)),
    [flat, refsEditing],
  );
  const {
    namedInTheTree,
    effectiveTeams,
    effectiveTags,
    effectiveServices,
    ownershipKnown,
    membershipKnown,
    mismatchByRow,
    effectiveTeamLabelOf,
    effectiveTagLabelOf,
    effectiveServiceLabelOf,
  } = usePlanLabels({ flat, teams, tags, services, people });

  /**
   * A pending Ctrl+D whose row the tree no longer holds — or no longer holds
   * under the number the toast promised — is disarmed.
   *
   * "Ctrl+D again deletes 020" stops being true the moment somebody else
   * deletes that row, or moves it, or creates one above it and renumbers it.
   * The arm holds the id *and* the number for exactly this: matching on the id
   * alone would leave the second press aimed at a row that is now 030 while
   * the sentence on screen still says 020.
   *
   * Proof: this effect removed, `a peer deleting the armed row disarms it`
   * failed on `expected '020' to be null` — an arm still tinted and still
   * live on a row that had gone. Watched, 2026-08-08.
   */
  useEffect(() => {
    setArmedDelete((armed) => {
      if (armed === null) return null;
      const still = flat.find((row) => row.id === armed.rowId);
      return still?.number === armed.number ? armed : null;
    });
  }, [flat, setArmedDelete]);
  const {
    gaps,
    criteria,
    search,
    filtering,
    filterLabels,
    facetTeams,
    facetTags,
    facetServices,
    facetPeople,
    facetBands,
    facetSteps,
  } = usePlanFilter({
    flat,
    steps,
    effectiveTeams,
    effectiveServices,
    mismatchByRow,
    effectiveTags,
    priorityBands,
    query,
    facets,
    teams,
    chartRead,
    tags,
    workItemTypes,
    services,
  });
  const { siblingsOf, addWorkItem } = useAddWorkItem({
    flat,
    projectId,
    activeProject,
    run,
    api,
    focusIntent,
  });
  const { frameState, resizeColumn, resizeGantt, resetGanttSettings, resetLayout, columnsDiffer } =
    usePlanLayout({
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
    });
  const {
    planForExport,
    copyAsMarkdown,
    copyAsMermaid,
    downloadCsv,
    downloadMermaidDocument,
    registerSvgDownload,
    downloadChartSvg,
  } = usePlanExportActions({
    projectName,
    estimateMethod,
    startDate,
    scheduleError,
    steps,
    teams,
    tags,
    services,
    people,
    priorityBands,
    flat,
    chartRead,
    pushToast,
    mermaidSectionMode,
  });
  const { walkToNextGap } = usePlanReadiness({
    flat,
    gaps,
    gapVisit,
    unfoldedSteps,
    setExpanded,
    setGapVisit,
    gridElement,
  });
  const {
    dropOn,
    addSibling,
    indent,
    outdent,
    moveAmongSiblings,
    duplicateRow,
    deleteRow,
    commitNameCell,
    removeEmptyRow,
  } = usePlanStructure({
    dragging,
    setDragging,
    setDropHint,
    flat,
    pushToast,
    setExpanded,
    run,
    api,
    projectId,
    focusIntent,
    siblingsOf,
  });
  const { onKeyDown, onTabKey, onArrowKey, onAltMove, onCommandKey } = usePlanKeyboard({
    outdent,
    indent,
    drafts,
    removeEmptyRow,
    busy,
    pushToast,
    moveAmongSiblings,
    setArmedDelete,
    armedDelete,
    dReleased,
    deleteRow,
    commandInFlight,
    addSibling,
  });
  const { dependenciesOf, dependOn, depEntriesFor, pickDependency, moveDepHighlight } =
    usePlanDependencies({
      flat,
      pushToast,
      setBusy,
      api,
      refreshOrMarkStale,
      setDepPicker,
      run,
      steps,
    });
  const {
    estimateValue,
    trioProblemFor,
    commitEstimate,
    combinedValue,
    combinedProblem,
    commitCombinedEstimate,
  } = useEstimateDrafts({ drafts, setDrafts, run, api });
  const {
    setNotBefore,
    setNotBeforeReason,
    setDeadline,
    setPriority,
    setParallelism,
    editingNotBefore,
    openNotBefore,
    closeNotBefore,
    editingDeadline,
    openDeadline,
    closeDeadline,
  } = usePlanFields({ run, api, priorityBands, pushToast, gridElement });
  const {
    setTeamOf,
    setServicesOf,
    setTagsOf,
    createTeamFor,
    createServiceFor,
    setExternalRefsOf,
    setTypesOf,
    createTypeFor,
    createTagFor,
    assignTo,
    createPersonFor,
    chooseEstimateMethod,
  } = useReferenceSets({ run, api, projectId });
  const { enterFoldedCell, readFoldedCell, closeMention, leaveFoldedCell, mentionOptions } =
    useEstimateMentions({
      foldedBox,
      foldedAtFocus,
      setMention,
      mention,
      people,
      assignTo,
      teams,
      createPersonFor,
    });
  const { hasSchedule, showSchedule, spanOf } = usePlanSchedule({ scheduleError });
  const { nonOwnerNoteOf, assigneeOn, anyAssigneeOn } = usePlanAssignments({
    effectiveTeams,
    teams,
    mismatchByRow,
    services,
    people,
    flat,
  });

  /**
   * The work items one waits for, in the order it holds them.
   *
   * The entries and not just their numbers, since `card-field-pickers` chunk 7:
   * the card's line became a control, and a wait that can be taken off has to
   * name the row a removal is keyed by. `dependenciesOf` already builds exactly
   * this, so widening it is dropping a `.map` rather than adding a second pass.
   */
  const waitsFor = useCallback((row: TreeRow) => dependenciesOf(row.dependsOn), [dependenciesOf]);
  const { goToRow } = useRowNavigation({ gridElement });

  /**
   * What holds each row's start, in the chart's own words — filled below, once
   * {@link ganttPlan} exists, and read by the `Start` cell out of the returned
   * tree.
   *
   * The stable ref is carried by {@link PlanLiveValues}; the map is filled only
   * after the chart projection exists. Cells render after that assignment and
   * therefore read the latest floor without rebuilding their definitions.
   *
   * Empty until the first render gets far enough to fill it, which is the same
   * state a payload the geometry cannot explain leaves it in: a cell that says
   * only its date, exactly as it did before this existed.
   */
  const startFloor = useRef<ReadonlyMap<string, string>>(new Map());

  /**
   * The current cell values, built once.
   *
   * They used to be written twice — the `useRef` initialiser and the
   * assignment under it were the same literal, so every render allocated two
   * identical objects and every new field had to be added in both
   * places or read `undefined` through one of them. Nothing enforced the
   * pairing; the second copy was a transcription.
   *
   * The initialiser still runs on later renders (an argument is evaluated
   * whether `useRef` keeps it or not), so this is the same work once rather
   * than a saving that depends on the first render. `live.current` is
   * reassigned every render exactly as before, and holds the same object the
   * initialiser saw on the first one.
   */
  const liveNow: PlanLiveValues = {
    focusIntent,
    gridElement,
    startFloor,
    api,
    projectId,
    run,
    busy,
    duplicateRow,
    deleteRow,
    commitNameCell,
    onKeyDown,
    onTabKey,
    onArrowKey,
    onAltMove,
    onCommandKey,
    armedDelete,
    setDragging,
    setDropHint,
    dependenciesOf,
    dependOn,
    hasSchedule,
    showSchedule,
    depPicker,
    setDepPicker,
    depLights,
    openMenuRowId,
    setOpenMenuRowId,
    depEntriesFor,
    pickDependency,
    moveDepHighlight,
    estimateValue,
    trioProblemFor,
    commitEstimate,
    combinedValue,
    combinedProblem,
    commitCombinedEstimate,
    mention,
    enterFoldedCell,
    readFoldedCell,
    closeMention,
    leaveFoldedCell,
    mentionOptions,
    openCard,
    setHoveredCell,
    setFocusedCell,
    setNotBefore,
    setNotBeforeReason,
    setDeadline,
    setPriority,
    priorityBands,
    setParallelism,
    effectiveTeamLabelOf,
    effectiveTagLabelOf,
    effectiveServiceLabelOf,
    editingNotBefore,
    openNotBefore,
    closeNotBefore,
    editingDeadline,
    openDeadline,
    closeDeadline,
    startDate,
    teams,
    tags,
    services,
    workItemTypes,
    externalSystems,
    setRefsEditing,
    people,
    setTeamOf,
    setTagsOf,
    setServicesOf,
    setTypesOf,
    setExternalRefsOf,
    createTeamFor,
    createServiceFor,
    createTagFor,
    createTypeFor,
    assignTo,
    createPersonFor,
    toggleStep,
    spanOf,
    assigneeOn,
    anyAssigneeOn,
    nonOwnerNoteOf,
    waitsFor,
    matchIds: search.matchIds,
    filtering,
  };

  const live = useRef(liveNow);
  live.current = liveNow;

  const columns = useMemo(
    () => createPlanColumns(steps, unfoldedSteps, hiddenColumnIds, live),
    // PlanLiveValues declares the structural inputs allowed to replace cells.
    // Proof: adding workItems here failed plan-read-and-write.test.tsx’s
    // `does not take the focus or the half-typed value` at the focus assertion:
    // activeElement was body instead of the Name cell (2026-09-06).
    [steps, unfoldedSteps, hiddenColumnIds],
  );

  const table = useTable({
    features: PLAN_TABLE_FEATURES,
    data: workItems,
    columns,
    // While a search is on, the expansion in force is the search's overlay:
    // every kept row open, so a hit inside a branch this reader had closed is
    // revealed rather than counted and hidden. The reader's own `expanded` is
    // not merged into and not written over — clearing the box puts the plan
    // back exactly as it was left, collapsed branches included.
    //
    // Proof: narrowed to the reader's own `expanded`, `reveals a match inside
    // a branch the reader had closed` failed with the hit counted and hidden.
    // And with the overlay committed into `expanded` on the way out — the
    // merge this avoids — `clearing the search puts the reader’s own collapse
    // back` failed with the whole plan open. Both watched, 2026-08-06.
    state: { expanded: search.expandedOverlay ?? expanded },
    onExpandedChange: setExpanded,
    // The expansion is this component's — remembered per project, opened on
    // a drop and on a gap visit, never the table's to reset. TanStack Table 9
    // resets it to `{}` after every row-structure change unless told not to,
    // and every write here refetches the tree, so without this line the plan
    // folded shut on its own first edit.
    //
    // Proof: with this line removed, 69 jsdom tests failed, `types a
    // three-level breakdown without touching the mouse` among them on
    // `expected [ '010' ] to deeply equal [ '010', '010.1' ]` — the table's
    // `expanded` read back as `{}` on the render after the indent's refetch.
    // Observed 2026-09-06.
    autoResetExpanded: false,
    getSubRows: (row) => row.subRows,
    getRowId: (row) => row.id,
  });

  /**
   * The rows this render puts on screen.
   *
   * The overlay above opens every kept row; this drops the ones a search did
   * not keep — the siblings that neither match nor sit on a match's line, which
   * are open branches' children and so still in the row model. With nothing
   * typed the kept set is every row and this filters nothing out.
   */
  const rowModel = table.getRowModel().rows;
  // Memoised because it is the chart's own key: `GanttPanel` lays the whole
  // chart out in a `useMemo` on `plan`, and a fresh array here made every render
  // of this table — every keystroke in the Find box, every hover card, every
  // `busy` toggle — re-lay-out every bar.
  const shownRows = useMemo(
    () => rowModel.filter((row) => search.visibleIds.has(row.id)),
    [rowModel, search.visibleIds],
  );

  // The rows a dependency hover lights were derived here, per render of the
  // table, until 2026-09-02: `dep-light-store.ts` owns that derivation and the
  // proofs that guard it now. What this component still owns is the **world**
  // the resolution reads — the tree as it was last drawn — pushed below, beside
  // the pointed store's shown rows.

  /**
   * Keeps the store's shown-row guard current: the resolution must drop a
   * remembered table hover the moment its row is no longer drawn, and only
   * this component knows what is drawn. Pushed after every commit — the store
   * tells nobody unless the resolved row actually changes, so the per-render
   * push is silent while nothing relevant moved. The guard itself, its
   * precedence and its proofs live in {@link createPointedRows}; the browser's
   * half (that Chromium really does leave the id behind under a stationary
   * pointer) is `e2e/hover-cards.spec.ts`'s 'a row narrowed away under the
   * pointer stops outranking the chart'.
   */
  useEffect(() => {
    pointedRows.setShownRows(new Set(shownRows.map((row) => row.original.id)));
  }, [pointedRows, shownRows]);

  /**
   * The dependency store's own world: what each row waits for, as the tree was
   * last read.
   *
   * `flat` and not `shownRows`, deliberately — a dependency whose row is
   * collapsed or filtered out is still in the hovered row's set, lights no
   * `<tr>` because none is drawn, and is still named by the card. That is the
   * guarantee the change spelled out, and reading the shown rows here would
   * quietly narrow it.
   *
   * Pushed per commit, and silent while nothing moved: the store compares the
   * lit set before it tells anybody.
   */
  useEffect(() => {
    const dependsOnOf = new Map(flat.map((row) => [row.id, row.dependsOn]));
    depLights.setDependsOnOf((rowId) => dependsOnOf.get(rowId));
  }, [depLights, flat]);

  /**
   * The Gantt panel's report line into the store — stable so the chart's
   * memoized marks, which carry it on every bar, never churn on a render of
   * this component.
   */
  const pointChartRow = useCallback(
    (rowId: string | null, from: 'pointer' | 'focus') => {
      pointedRows.pointChart(rowId, from);
    },
    [pointedRows],
  );
  const { dependsCellHoverProps, startSentence, startCellProps } = createPlanCellProps({
    dependenciesOf,
    depLights,
    depPicker,
    setHoveredCell,
    live,
    openCard,
  });
  const { ganttPlan } = usePlanChartInput({
    shownRows,
    startDate,
    effectiveTeamLabelOf,
    effectiveTagLabelOf,
    namedInTheTree,
    chartRead,
    flat,
    filtering,
    teams,
    priorityBands,
    startFloor,
  });
  const { downloadOnScreen } = usePlanOnScreenExport({
    planForExport,
    shownRows,
    flat,
    criteria,
    filterLabels,
  });

  /**
   * The columns this render puts on screen, in order — which is exactly what a
   * `<colgroup>` declares and what the table's own width adds up. Read from the
   * table model rather than listed here, so unfolding a step cannot leave the
   * declared widths describing the columns of a moment ago.
   */
  // `getAllLeafColumns`, not `getVisibleLeafColumns`: a hidden column is left
  // out of `columns` (see `hiddenColumnIds`) rather than hidden through table
  // state, so every column the table has is a shown one and the visibility
  // feature is not among `PLAN_TABLE_FEATURES`. Same for `getAllCells` on the
  // rows below.
  const leafColumnIds = table.getAllLeafColumns().map((column) => column.id);

  /**
   * Every width this render declares, resolved once.
   *
   * The `<colgroup>`, the table's `min-width` and every pinned cell read this
   * one object — see {@link frameLayout}, which is where the five separate
   * arithmetics used to be. It is **not** read inside a column definition and
   * must never be: `flexRender` renders each `cell` as a component type, so a
   * definition that changed with a width would remount every cell in the table
   * and take the focus and the half-typed value with it (LLM_README landmine
   * #1).
   */
  const layout = frameLayout(leafColumnIds, frameState);

  /**
   * What the headings' hints may bend for, in one object beside the layout's.
   *
   * Read in the `<thead>` render and nowhere else, and deliberately **not**
   * inside a column definition — landmine #1 again: the schedule columns'
   * sentence changes the day the project gets a start date, and a definition
   * that changed with it would remount every cell in the table on that edit.
   */
  const hintState: ColumnHintState = { hasProjectStartDate: startDate !== null };

  /**
   * The resize handle for one heading — every leaf column carries one since
   * `name-column-drag`, the Name column included.
   *
   * Until that change a column resolving no width was refused a handle, and
   * Name was exactly that column. A dragged Name writes an override now, so
   * the suppression is retired: the one thing that still varies is where the
   * gesture's from-width comes from, and that is
   * {@link ColumnResizeHandle}'s to answer.
   *
   * `declaredHeading` is what the column definition calls itself, which is a
   * string for most of them and a node for the ones whose heading is a glyph or
   * carries a control. A node whose column declared
   * {@link ColumnMeta.spokenHeading} is called with the word instead — the call
   * site resolves it — and the rest fall back to the column id: a name a screen
   * reader can say, rather than a node this cannot read text out of.
   *
   * Proof: the call site reading `columnDef.header` alone, `says a mark
   * heading's word on the handle beside it` failed on `expected 'Resize
   * number' to be 'Resize Number'`. Watched on h2puni, 2026-08-12.
   *
   * @throws {Error} for a heading the layout did not resolve. Every header
   * cell in this table is a leaf column of the same model `layout` was built
   * from, so a miss is the overlap bug's shape — a column laid out by nothing
   * — not a state to render around.
   */
  function resizeHandleFor(columnId: string, declaredHeading: unknown): ReactNode {
    const resolved = layout.columns.find((column) => column.id === columnId);
    if (resolved === undefined) {
      throw new Error(`the ${columnId} heading is not a column this layout resolved`);
    }
    // Proof: the retired undefined-width suppression restored above this
    // return, `offers a handle on every column, the Name column included`
    // failed on `expected [ 'drag', 'number', 'depends', …(13) ] to deeply
    // equal [ 'drag', 'number', 'name', …(14) ]` — Name refused its handle
    // again. Watched, 2026-08-10.
    return (
      <ColumnResizeHandle
        columnId={columnId}
        heading={typeof declaredHeading === 'string' ? declaredHeading : columnId}
        width={resolved.width}
        state={frameState}
        resize={resizeColumn}
      />
    );
  }
  const toolbarControls = (
    <PlanToolbar
      criteria={criteria}
      freezeMenuOpen={freezeMenuOpen}
      setFreezeMenuOpen={setFreezeMenuOpen}
      busy={busy}
      run={run}
      api={api}
      projectId={projectId}
      addWorkItem={addWorkItem}
      filtering={filtering}
      setExpanded={setExpanded}
      ganttOpen={ganttOpen}
      setGanttOpen={setGanttOpen}
      renderer={renderer}
      teams={teams}
      teamCapacities={teamCapacities}
      flat={flat}
      effectiveTeams={effectiveTeams}
      refreshOrMarkStale={refreshOrMarkStale}
      priorityBands={priorityBands}
      steps={steps}
      hiddenColumnIds={hiddenColumnIds}
      frameState={frameState}
      people={people}
      chartRead={chartRead}
      estimateMethod={estimateMethod}
      query={query}
      setQuery={setQuery}
      facets={facets}
      setFacets={setFacets}
      facetTeams={facetTeams}
      facetTags={facetTags}
      facetServices={facetServices}
      facetPeople={facetPeople}
      facetBands={facetBands}
      facetSteps={facetSteps}
      ownershipKnown={ownershipKnown}
      membershipKnown={membershipKnown}
      savedViews={savedViews}
      filterLabels={filterLabels}
      setSavedViews={setSavedViews}
      setStoredHiddenColumns={setStoredHiddenColumns}
      offeredColumns={offeredColumns}
      toggleColumn={toggleColumn}
      shownRows={shownRows}
      search={search}
      gaps={gaps}
      walkToNextGap={walkToNextGap}
      stack={stack}
      stepStack={stepStack}
      setCheatSheetOpen={setCheatSheetOpen}
      copyAsMarkdown={copyAsMarkdown}
      copyAsMermaid={copyAsMermaid}
      downloadCsv={downloadCsv}
      downloadMermaidDocument={downloadMermaidDocument}
      downloadChartSvg={downloadChartSvg}
      downloadOnScreen={downloadOnScreen}
      mermaidSectionMode={mermaidSectionMode}
      setMermaidSectionMode={setMermaidSectionMode}
      startDate={startDate}
      chooseEstimateMethod={chooseEstimateMethod}
    />
  );

  return (
    /*
      A link in the chain from `<main>` down to the frame: this section takes
      the height its parent has, and passes the remainder — what the toolbar and
      any banner leave — to the frame at the bottom of it. `min-h-0` is what
      lets it shrink below the table's own height; without it the whole chain
      falls back to content height and the frame never scrolls. `ProjectPage`
      has the same pair on `<main>`, and `table-frame.ts` has the why.
    */
    <section
      // The column the chart panel is bounded by, and the box
      // {@link ganttRoomPx} is measured from. Every other reader finds it by
      // `[data-slice-count]`, including the browser gate.
      ref={ganttColumn}
      className="flex min-h-0 flex-1 flex-col"
      // How many slices the plan on screen was drawn from. The Gantt panel at
      // the bottom of this section draws them now, but only while it is open —
      // so this stays as the trace they leave with it closed, which is what
      // lets `wbs-table.test.tsx` watch "a refetch replaces the slices" break
      // without opening a chart.
      data-slice-count={chartRead.slices.length}
    >
      {/*
        Two places for one toolbar, and which one is a fact about the viewport.

        Wrapping, because this row of controls is the only thing on the page
        that can make it scroll sideways: it is about 1245px of buttons at its
        narrowest, and a window below that — a narrow one, or a wide one at
        125% zoom — carried the whole page with it while the table itself was
        behaving perfectly. Observed on h2puni, 2026-08-08. On a phone it does
        not wrap, it folds: 1245px of controls above a 390px screen is a page
        of buttons with the plan somewhere under them.
      */}
      {renderer === 'cards' ? (
        <div data-toolbar-sheet className="mb-1.5 flex shrink-0 items-center gap-2">
          <PlanToolbarSheet>
            <div aria-busy={busy} className="flex flex-wrap items-center gap-2">
              {toolbarControls}
              {(ganttHeightPx !== null || ganttDayPx !== DAY_PX || !ganttLabelsShown) && (
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  data-hint="Forget the chart height, the day scale and the hidden row names, and lay the Gantt out at its own again"
                  onClick={resetGanttSettings}
                >
                  Reset layout
                </Button>
              )}
              {/*
                The saved-plan shelf, which on a phone lives here and nowhere
                else — the header's project row cannot afford it, and
                `SavedPlanShelf` carries the 21.4px that says so.

                Last in the sheet and not in `toolbarControls`, for that
                array's own reason turned around: it is rendered by *both*
                faces, and this control is on this one only. Above `md` the
                shelf is in the app header, and this arm is not rendered at all.
              */}
              {savedPlansShelf}
            </div>
          </PlanToolbarSheet>
        </div>
      ) : (
        <div
          data-toolbar
          // Said out loud, because a control that is unavailable for a moment
          // and one that is unavailable for good look the same otherwise —
          // see {@link busyAffordance} for the click this makes visible.
          aria-busy={busy}
          className="mb-1.5 flex shrink-0 flex-wrap items-center gap-x-1.5 gap-y-1"
        >
          {toolbarControls}
          {/*
            The layout reset, and the whole of why it is **here** — the
            toolbar row's own child — rather than in `toolbarControls`: that
            array is rendered both in this row and in the Plan actions sheet,
            so a control put there reaches the phone by construction. The
            width half stays here because a phone card has no columns to
            widen; the sheet instead carries its own Gantt-only reset, for
            the height, day scale and row-name labels a card does have.

            Offered only while there is something to forget — a dragged
            column or a dragged chart edge. A control that provably does
            nothing reads as a broken one. Proof of the height half: the
            `ganttHeightPx` arm of the condition removed, `a height override
            alone offers the reset…` failed on `Unable to find … "Reset
            layout"`. Watched, 2026-08-10.

            Proof of the placement: the reset moved into `toolbarControls`,
            `plan-cards.test.tsx`'s `offers no width control at all, because a
            card has no columns` failed on `expected <button …(2)></button> to
            be null` — the control on the sheet at 390px. Watched, 2026-08-09.
          */}
          {hasSuccessfulTreeRead &&
            (widthOverrides.size > 0 ||
              columnsDiffer ||
              ganttHeightPx !== null ||
              ganttDayPx !== DAY_PX ||
              !ganttLabelsShown) && (
              <Button
                variant="outline"
                size="sm"
                type="button"
                data-hint="Forget the widths, the hidden columns, the chart height, the day scale and the hidden row names set here, and lay the layout out at its own again"
                onClick={resetLayout}
              >
                Reset layout
              </Button>
            )}
        </div>
      )}

      {chartRead.optimization !== undefined && (
        <OptimizationIndicator
          optimization={chartRead.optimization}
          stale={treeMayBeStale}
          projectStart={startDate}
          today={new Date()}
          workItemName={(id) => flat.find((row) => row.id === id)?.name ?? null}
        />
      )}

      {/*
        A state, so a banner: the rows on screen are the last ones that
        arrived, and until a read lands they may be behind what be-01 holds.
        The alternative was to say nothing, which left a plan that could be
        minutes out of date looking exactly like one that was current.

        The retry is the only control here, because it is the only thing the
        reader can do about it — and it clears this by succeeding, not by being
        pressed.
      */}
      {treeMayBeStale && (
        <p
          role="alert"
          data-stale-tree
          className="border-destructive/40 bg-destructive/10 mb-3 flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
        >
          This plan may be out of date — the last refresh failed.{' '}
          <Button
            variant="outline"
            size="sm"
            type="button"
            onClick={() => {
              void refreshOrMarkStale();
            }}
          >
            Retry
          </Button>
        </p>
      )}

      {/*
        Said out loud rather than left to be noticed. Someone else's edits stop
        arriving the moment the socket drops, and a table that looks exactly the
        same when it is no longer live is the failure this whole change exists
        to remove.
      */}
      {/*
        Not an error the user caused, and not one they can leave alone. The rows
        are all still here — only the dates are gone — so this says which, rather
        than letting a page of zeroes speak for itself.
      */}
      {scheduleError === 'cycle' && (
        <p
          className="border-destructive/40 bg-destructive/10 mb-3 rounded-md border px-3 py-2 text-sm"
          role="alert"
        >
          These dependencies run in a circle, so no dates can be worked out. Remove one to fix it.
        </p>
      )}

      {!connected && (
        <p className="text-muted-foreground mb-3 text-sm" role="status">
          Reconnecting — edits by other people may not be shown yet.
        </p>
      )}

      {renderer === 'cards' ? (
        /*
          The same rows, the same order, the same open branches: `shownRows` is
          the table model's answer and both renderers draw it. What the cards
          get instead of the frame is an ordinary scrolling column — there is
          nothing sticky to hold, because there are no columns to pin.
        */
        <PlanCards
          rows={shownRows.map((row) => ({
            row: row.original,
            depth: row.depth,
            // No triangle while a search is on, for the reason the Number
            // column gives: what is open during a search is the search's own
            // answer, and a control that appeared to do nothing reads as broken.
            expandable: row.getCanExpand() && !filtering,
            expanded: row.getIsExpanded(),
            toggleBranch: row.getToggleExpandedHandler(),
            // The same set the table's Name cell marks from, so a plan read on
            // a phone and on a laptop marks the same rows. Read straight here
            // rather than through `live`: the cards are not a memoised column
            // definition, and there is no per-keystroke remount to protect.
            matched: search.matchIds.has(row.id),
          }))}
          steps={steps}
          priorityBands={priorityBands}
          gridRef={(node) => {
            gridElement.current = node;
          }}
          commitName={commitNameCell}
          claimFocus={(node, cell) => {
            focusIntent.current.landOnAttached(node, cell, gridElement.current);
          }}
          estimateValue={combinedValue}
          estimateProblem={combinedProblem}
          commitEstimate={commitCombinedEstimate}
          enterEstimate={enterFoldedCell}
          readEstimate={readFoldedCell}
          closeMention={closeMention}
          leaveEstimate={leaveFoldedCell}
          mentionOptions={mentionOptions}
          assigneeOn={assigneeOn}
          waitsFor={waitsFor}
          // The Depends cell's own picker rule and its own two writers, handed
          // to the face that had neither. `depEntriesFor` is `pickerEntries`,
          // which is a *ported copy of be-01's judgement* about which edges are
          // refusable — the one rule in this dimension that two implementations
          // would quietly disagree about — so the card asks the same question of
          // the same function and greys the same rows. `pickDependency` and
          // `removeDependency` are the paths the table's list and its chip `✕`
          // take, for `rowActions`' bargain, a fifth dimension over.
          dependencyOptions={(row, typed) => depEntriesFor(row, typed)}
          addDependency={(row, predecessorId) => {
            return pickDependency(row.id, predecessorId);
          }}
          dropDependency={(row, predecessorId) => {
            return run(() => api.removeDependency(row.id, predecessorId));
          }}
          // The `Start` cell's own sentence, off the one map, handed to the
          // face that has no hover to give it. `startFloor.current` is filled
          // two hundred lines above this JSX, from the same `ganttPlan` the
          // chart is drawn from — so a plan read on a phone and on a laptop
          // cannot be told two different things about one wait.
          //
          // `?? null` and never the empty string: a row this map has no entry
          // for is a row the geometry refused to explain, and the card's
          // contract is that `null` is the only way to say so.
          startFloor={(row) => startFloor.current.get(row.id) ?? null}
          teamLabel={effectiveTeamLabelOf}
          // The Service/team cell's own directory and its own two writers,
          // handed to the other face — `rowActions`' bargain, one dimension
          // over. Not card-shaped copies: `setTeamOf` is what makes the patch
          // and `createTeamFor` is what makes a team idempotently by name, so a
          // team chosen on a phone reaches be-01 by the path a team chosen on a
          // laptop reaches it by.
          teams={teams}
          setTeams={(row, teamIds) => {
            return setTeamOf(row.id, teamIds);
          }}
          createTeam={(row, name, currentTeamIds) => {
            return createTeamFor(row.id, name, currentTeamIds);
          }}
          // The `not-before` and `deadline` cells' calendar, handed to the face
          // that cannot read it from a row. Both controls derive availability
          // from it, and the deadline also uses the date to identify a stored
          // deadline that the project start has moved past.
          projectStart={startDate}
          // Both boxes in one call, which is what the third argument is for —
          // `setNotBefore` is the table's own writer widened, not a card-shaped
          // copy, so a date set on a phone reaches be-01 by the path a date set
          // on a laptop reaches it by, and the pair rule be-01 checks inside one
          // transaction is answered by one request.
          setNotBefore={(row, day, reason) => {
            setNotBefore(row.id, day, reason);
          }}
          // A deadline has no reason field, so clearing it remains one field.
          setDeadline={(row, day) => {
            setDeadline(row.id, day);
          }}
          // The Prio cell's own writer, handed to the face that had none — and
          // the string, not a parsed number, because `setPriority` is where
          // three rules live that a card must not keep a second copy of: a
          // band's name resolving to its number, the refusal toast for
          // anything that is not a whole number from 1 upward, and an emptied
          // box meaning `null` rather than `0`.
          setPriority={(row, typed) => {
            return setPriority(row.id, typed);
          }}
          tagLabel={effectiveTagLabelOf}
          tags={tags}
          setTags={(row, tagIds) => {
            return setTagsOf(row.id, tagIds);
          }}
          createTag={(row, name, current) => {
            return createTagFor(row.id, name, current);
          }}
          serviceLabel={effectiveServiceLabelOf}
          services={services}
          setServices={(row, serviceIds) => {
            return setServicesOf(row.id, serviceIds);
          }}
          createService={(row, name, current) => {
            return createServiceFor(row.id, name, current);
          }}
          // The same sentence the Services cell's `△` carries, handed to the
          // face that had none. Not a card-shaped copy of the rule: one memo
          // (`mismatchByRow`) answers both renderers, so a phone and a laptop
          // cannot disagree about which services a team does not own.
          nonOwner={nonOwnerNoteOf}
          spanOf={spanOf}
          showDay={showDay}
          // The `actions` column's own three handlers, handed to the only other
          // face this plan has. Not card-shaped copies of them: `duplicateRow`
          // and `deleteRow` are the callbacks the table's ⋯ calls, so a row
          // duplicated on a phone lands the caret where a row duplicated on a
          // laptop does, and a delete promotes its children the same way.
          //
          // Read straight rather than through `live`, unlike the column that
          // does the same three things: `columns` is a memo that must not
          // depend on state, and this is ordinary JSX in the render — reading
          // `live.current` here would pin the handlers to whichever render
          // built the ref last.
          //
          // Unfreeze has no `unfreezeRow` of its own to borrow because the
          // table has none either; both faces spell it the same way, one `run`
          // around one request.
          rowActions={{
            busy,
            duplicate: (rowId) => {
              void duplicateRow(rowId);
            },
            unfreeze: (rowId) => {
              void run(() => api.unfreezeWorkItem(rowId));
            },
            remove: (row) => {
              void deleteRow(row);
            },
          }}
        />
      ) : (
        <>
          {/*
            The table scrolls inside this, in both directions, so the page never
            scrolls sideways and the toolbar and the alerts above stay where they
            were put. The heading row and the three identity columns are sticky
            against this box — see `table-frame.ts` for why it has to be the one
            that scrolls.
          */}
          <div data-table-frame ref={frameRef} style={TABLE_FRAME}>
            {/*
            `separate` with no spacing rather than the browser's default gap:
            the pinned columns' offsets are the running total of their widths,
            and two pixels between every pair of cells is two pixels the offsets
            do not know about.
          */}
            {/*
            `data-grid` marks the whole of the editable grid for the cascade, and
            it is the only thing this change writes into the table. Every rule in
            `styles.css`'s `@layer base` carries `:not([data-grid], [data-grid] *)`,
            so the scoped reset the vendored components need stops at this
            element: the cells, their inputs, the ⋯ menu and both pickers keep the
            `box-sizing`, margins and platform font the browser gives them, which
            is what `table-frame.ts`'s width table was measured against.

            An attribute rather than a class, because it is a marker and not a
            style — and because `editable-grid.ts` finds the grid by it: since
            `X live-editing-extraction` that module reads this attribute rather
            than `closest('table')`, so a renderer that is not a table still has
            a grid (agy #11).
          */}
            <table
              data-grid
              // A callback rather than the ref object itself: `gridElement` holds
              // an `HTMLElement` since `M mobile-cards` — a `<table>` here and a
              // list of cards below the breakpoint — and React will not hand a
              // widened ref object to a `<table>`.
              ref={(node) => {
                gridElement.current = node;
              }}
              style={{
                borderCollapse: 'separate',
                borderSpacing: 0,
                // `fixed`, so the browser lays every column out at the width
                // `table-frame.ts` says it has. Under the default `auto` the
                // widths were a suggestion the content could outvote, and a column
                // that came out wider than the offsets assumed is a pinned Name
                // painted over "Depends on".
                tableLayout: 'fixed',
                // The frame's width at rest, and the resolved sum while a
                // dragged Name holds an override — `tableWidthStyle` is the
                // one line the excess-width measurement decided, and its JSDoc
                // holds the observation. The minimum stays the floor either
                // way: below it the frame scrolls sideways with the pinned
                // columns holding the left edge.
                ...tableWidthStyle(layout),
              }}
            >
              {/*
              The one place the declared widths reach the browser. `col` sizes a
              column and nothing else about it, which is why the cells below
              carry no width of their own.

              A flexible column gets a `<col>` with no width at all — not a
              width of `auto`, which is the same thing said less clearly — and
              `table-layout: fixed` hands it whatever the declared ones leave.
            */}
              <colgroup>
                {layout.columns.map((column) => (
                  // `colWidth`, not `width`: a dragged Name resolves a width
                  // and its `<col>` must still stay silent, or fixed layout
                  // distributes the viewport's excess across every sized
                  // column and moves Number off its measured envelope. The
                  // dragged width rides on the Name cells below;
                  // `e2e/layout.spec.ts` measures the consequence.
                  // Proof: re-pointed at `column.width`, `lays a remembered
                  // Name width on the Name cells, and leaves its <col> silent`
                  // failed on `expected '300px' to be ''` — a sized
                  // `<col name>`. Watched, 2026-08-10. The browser half of the
                  // same fault — the viewport's excess distributed, Number off
                  // 93 — is `e2e/layout.spec.ts`'s to watch.
                  <col
                    key={column.id}
                    style={column.colWidth === undefined ? undefined : { width: column.colWidth }}
                  />
                ))}
              </colgroup>
              <thead>
                {table.getHeaderGroups().map((group) => (
                  <tr key={group.id}>
                    {group.headers.map((header) => (
                      <th
                        key={header.id}
                        scope="col"
                        // Which column this cell is, on the cell itself. Nothing in
                        // the app reads it: the browser layout gate does
                        // (`e2e/layout.spec.ts`), and a measured rectangle with no
                        // name attached is a failure that says two numbers
                        // disagreed without saying which column moved.
                        data-column={header.column.id}
                        // The word, where the heading under it is a mark; see
                        // {@link ColumnMeta.spokenHeading}. Undefined for every
                        // other column, which renders no attribute at all.
                        aria-label={header.column.columnDef.meta?.spokenHeading}
                        // What this column does to the plan (`column-hints.ts`).
                        // On the `<th>` and not on the heading inside it, for
                        // the reason the `aria-label` is: the cell is what the
                        // reader is resting on, and a `title` on an inner
                        // `<span>` covers the word and none of the padding
                        // around it. The two headings that carry their own
                        // `title` after this — the step's fold button and the
                        // resize handle — describe a *control*, not a column,
                        // and the fold button opens with this same sentence so
                        // that hovering it still teaches the column.
                        data-hint={hintFor(header.column.id, hintState)}
                        style={{
                          ...CELL,
                          ...STICKY_HEADER_CELL,
                          ...flexibleCellStyle(header.column.id, frameState),
                          ...pinnedCellStyle(layout, header.column.id, 'header'),
                        }}
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {/*
                        The grab handle, on the trailing edge of every column
                        the layout declared a width for and on no other. The one
                        column that resolves without a width is the flexible
                        one, and it has nothing to be dragged to: it is the
                        remainder above its floor, and asking for its declared
                        width is already an error.

                        Rendered here rather than in the column definition,
                        which is the rule the whole seam is built around: a
                        definition that changed with a width remounts every cell
                        in the table (landmine #1). The `<th>` is
                        `position: sticky` through `STICKY_HEADER_CELL`, which
                        is what the absolute strip is positioned against.
                      */}
                        {resizeHandleFor(
                          header.column.id,
                          header.column.columnDef.meta?.spokenHeading ??
                            header.column.columnDef.header,
                        )}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody>
                {shownRows.map((row) => (
                  <PlanRow
                    key={row.id}
                    rowId={row.original.id}
                    frozen={row.original.frozenNumber !== null}
                    depLights={depLights}
                    armed={armedDelete?.rowId === row.original.id}
                    drop={dropHint?.rowId === row.original.id ? dropHint.zone : undefined}
                    pointed={pointedRows}
                    // The drag handlers sit on the row rather than in a column
                    // definition: `flexRender` renders each `cell` as a
                    // component *type*, so a definition that changed with the
                    // drag would remount every cell in the table on every
                    // pointer move. Built here rather than in {@link PlanRow}
                    // because they read this component's drag state, which the
                    // shell has no business subscribing to.
                    onDragOver={(event) => {
                      if (dragging === null) return;
                      // Without this the browser refuses the drop outright.
                      event.preventDefault();
                      const box = event.currentTarget.getBoundingClientRect();
                      setDropHint({
                        rowId: row.original.id,
                        zone: zoneFor(event.clientY - box.top, box.height),
                      });
                    }}
                    onDragLeave={() => {
                      setDropHint((current) =>
                        current?.rowId === row.original.id ? null : current,
                      );
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      // The zone the last `dragover` worked out, not one recomputed
                      // here. That one is the marker the person was looking at when
                      // they let go, and a drop that lands somewhere other than where
                      // the line was drawn is the one thing drag must never do.
                      if (dropHint?.rowId !== row.original.id) return;
                      dropOn(
                        row.original.id,
                        dropHint.zone,
                        row.getIsExpanded() && row.subRows.length > 0,
                      );
                    }}
                  >
                    {row.getAllCells().map((cell) => (
                      <td
                        key={cell.id}
                        // See the `th` above: the layout gate measures these boxes
                        // and has to be able to name the one that moved.
                        data-column={cell.column.id}
                        // The dependency light's own cell-level reading, on the
                        // cell. See {@link dependsCellHoverProps}: it is the
                        // whole `<td>` and not a wrapper inside it, because the
                        // gesture the spec names is "the pointer is in this
                        // cell" and a wrapper stands inside the padding.
                        {...(cell.column.id === 'depends'
                          ? dependsCellHoverProps(row.original)
                          : {})}
                        {...(cell.column.id === 'start' ? startCellProps(row.original) : {})}
                        style={{
                          ...CELL,
                          // The exception to the cell clip. See
                          // {@link opensAPopover}: a popover's containing block is
                          // the wrapper span *inside* this `<td>`, so this `<td>`
                          // clips it unless it is told not to.
                          ...(opensAPopover(cell.column.id)
                            ? { overflow: 'visible' as const }
                            : {}),
                          ...(cell.column.id === 'start' && startSentence(row.original) !== null
                            ? { cursor: 'help' as const }
                            : {}),
                          ...flexibleCellStyle(cell.column.id, frameState),
                          ...pinnedCellStyle(layout, cell.column.id, 'body'),
                          // Last, so it wins over the pinned layer it is raising.
                          // A pinned cell is sticky *with a z-index*, which makes
                          // it a stacking context — so the preview hanging off
                          // this one is trapped inside it and the next row's
                          // pinned Name cell paints over it, whatever the
                          // preview's own z-index says. The Name column is the
                          // only cell in the table that is both pinned and holds a
                          // popover, and this is the row it is open on.
                          // Proof: found in a browser rather than reasoned about —
                          // `4px below the name cell is <textarea> in the name
                          // column, not the preview`, on h2puni 2026-08-08, with
                          // `opensAPopover` and every other rule already correct.
                          ...(cell.column.id === 'name' &&
                          openCard === cellKey(row.original.id, 'name')
                            ? { zIndex: POPOVER_ROW_LAYER }
                            : {}),
                          // After the pinned background, so the warning is visible
                          // on the three columns that hold the left edge too.
                          ...(armedDelete?.rowId === row.original.id
                            ? { background: ARMED_TINT }
                            : {}),
                        }}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </PlanRow>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/*
        Under the plan and inside the section, so the frame splits vertically:
        the panel scrolls itself and the table keeps its own frame. Neither is
        allowed to make the page scroll sideways, which is what the panel's own
        `overflow-auto` is for.

        Mounted under either renderer — the chart is the same chart on a phone,
        and the toggle that mounts it is in the same one toolbar the sheet
        opens.
      */}
      {/*
        The slack, given somewhere to live so the chart docks to the bottom of
        the column instead of floating in the middle of it.

        Dany, 2026-08-30, on a four-row plan: "i need the whole gantt panel to go
        down". This is the other half of `unified-scroll-docking` and it reverses
        that change's *outcome* rather than its reasoning. `TABLE_FRAME` went to
        `flex-grow: 0` on 2026-08-11 to stop a short plan putting 508px of
        nothing between its last row and the chart — which it did, by moving the
        same emptiness **below** the chart, where it is worse: the chart stopped
        being docked to anything. Measured in Chromium at 1600×1000 on a one-row
        plan, before this element existed: column 943px, children 439px, **528px
        of dead space under the panel**.

        **A spacer and not `mt-auto` on the handle, and that is the whole reason
        this is an element rather than a class.** An auto margin was tried first
        and it docked the panel correctly — and broke the drag, because
        `getComputedStyle` resolves `margin-top: auto` on a flex item to its
        *used* value, so `ganttRoomInColumn` read the absorbed slack as margin
        the column had spent and answered a room of nearly nothing. Dragging the
        handle up then could not grow the chart at all: 113px before the drag and
        113px after it, watched in Chromium.

        This element is free of that by the rule that function already documents:
        it is shrinkable and declares a definite `min-height`, so it is credited
        its floor of 0 rather than the height it stands at, and the room is the
        number it was before. Both halves are asserted in `e2e/gantt.spec.ts`.

        Rendered only while the chart is open. With it closed the column has no
        docked group to push down and the frame's own `flex-grow: 0` is the whole
        story, exactly as `unified-scroll-docking` left it.
      */}
      {ganttOpen && <div aria-hidden="true" style={GANTT_DOCK_SLACK} />}
      {ganttOpen && <GanttHeightHandle heightPx={ganttHeightPx} resize={resizeGantt} />}
      {ganttOpen && (
        // The boundary wraps the panel and nothing else, which is the whole of
        // the degradation this feature is allowed: a chart that cannot be drawn
        // costs the reader the chart, never the editor above it. See
        // {@link GanttFaultBoundary} for why it resets on the read rather than
        // on a key. The height handle above stands outside it for the same
        // reason turned around: the fault must not take the drag with it.
        <GanttFaultBoundary generation={chartRead.generation}>
          <GanttPanel
            plan={ganttPlan}
            startDate={startDate}
            scheduleError={scheduleError}
            generation={chartRead.generation}
            // The reader's claim, re-clamped against the column it is being
            // drawn in — and the claim itself left alone, in state and in
            // storage both, so a window that grows gives the dragged height
            // back rather than having quietly forgotten it.
            heightPx={appliedGanttHeight(ganttHeightPx, ganttRoomPx)}
            roomPx={ganttRoomPx}
            dayPx={ganttDayPx}
            // Stored where it is set and nowhere else, exactly as a let-go drag
            // is: opening a project must not write to it.
            onPickDayPx={(picked) => {
              setGanttDayPx(picked);
              rememberGanttDayPx(projectId, picked);
            }}
            labelsShown={ganttLabelsShown}
            // Stored where it is set and nowhere else, as the rung beside it is.
            onPickLabelsShown={(shown) => {
              setGanttLabelsShown(shown);
              rememberGanttLabels(projectId, shown);
            }}
            onPickRow={goToRow}
            // The panel reports which row the pointer or a bar's focus is
            // on, straight into the store it also lights from — no state of
            // this component moves, which is what keeps a pointed row from
            // re-rendering the plan. The store keeps the two readings apart
            // ({@link PointedRows}): a bar's blur must not clear a light the
            // pointer is holding.
            onPointRow={pointChartRow}
            pointed={pointedRows}
            // The calendar markers, and the four writes that change them.
            //
            // Read here and passed down, never read by the panel: the panel
            // draws the list it is given and reports every write back, so this
            // component is the one place where a write and the redraw after it
            // can agree. Rename and recolour stay **two** callbacks because
            // be-01 refuses a `PATCH` body naming both.
            markers={markers}
            onCreateMarker={(marker) => {
              void runMarkerWrite(() => api.createCalendarMarker(projectId, marker));
            }}
            onRenameMarker={(markerId, name) => {
              void runMarkerWrite(() => api.renameCalendarMarker(projectId, markerId, name));
            }}
            onRecolorMarker={(markerId, color) => {
              void runMarkerWrite(() => api.recolorCalendarMarker(projectId, markerId, color));
            }}
            onDeleteMarker={(markerId) => {
              void runMarkerWrite(() => api.deleteCalendarMarker(projectId, markerId));
            }}
            // The panel lends the toolbar its own `.svg` downloader while it is
            // mounted, and takes it back when it is not: the file is a clone of
            // the live drawing, so only the panel can make one.
            registerSvgDownload={registerSvgDownload}
          />
        </GanttFaultBoundary>
      )}

      {/*
        Outside the scrolling frame on purpose: it is fixed to the corner of
        the viewport, and the thing it replaced was a line above the table that
        scrolled out of sight exactly when it mattered.

        Proof that the line is really gone: restored as a second `role="alert"`
        above the table, `says a refused rename in a toast, and puts nothing
        above the table` failed on two alerts where it asserts one. Watched,
        2026-08-06.
      */}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />

      {/*
        Rendered only while it is open, which is what makes the focus return
        work: the overlay stores what had the focus when it mounted and gives
        it back when it unmounts, so all three ways of closing put the reader
        back where they were without any of them saying so.
      */}
      {cheatSheetOpen && (
        <KeyboardCheatSheet
          // The sheet says what *this* renderer answers, and nothing else. The
          // cards wire no chords at all, and a sheet promising ⌘+Enter on a
          // phone is the promise nothing keeps.
          renderer={renderer}
          onClose={() => {
            setCheatSheetOpen(false);
          }}
        />
      )}
      {/*
        The ref editor, rendered only while a row is being edited and driven
        from the row the tree currently holds rather than from a copy taken when
        it opened: a peer's edit landing mid-edit redraws the list.

        `refsEditingRow` can be null while `refsEditing` is not — the row was
        deleted, by this reader or a peer — and that is a modeled state rather
        than an invariant: the surface simply is not there, which is what a
        deleted row's editor should be.
      */}
      {refsEditingRow !== null && (
        <ExternalRefsModal
          open
          onOpenChange={(open) => {
            if (!open) setRefsEditing(null);
          }}
          number={refsEditingRow.number}
          refs={refsEditingRow.externalRefs}
          systems={externalSystems}
          onReplace={(refs) => {
            void setExternalRefsOf(refsEditingRow.id, refs);
          }}
        />
      )}
    </section>
  );
}

export { widthFromDrag } from './use-plan-layout';
export { type PlanReadScope, type SubscriptionHandlers, type WbsTableProps } from './use-plan-read';
