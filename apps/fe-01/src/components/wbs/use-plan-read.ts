import type { DependencyReach } from '@wbs/domain/dependency-reach';
import type * as React from 'react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import {
  ALL_RESOURCES,
  createPlanRefresh,
  type PlanRefresh,
  type PlanRefreshSnapshot,
  resourcesFor,
} from '@/lib/plan-refresh';
import type { ProjectStream } from '@/lib/project-stream';
import type {
  AssignedPersonView,
  CalendarMarkerView,
  ExternalSystemView,
  PersonView,
  PriorityBandView,
  ServiceView,
  TagView,
  TeamCapacityView,
  TeamView,
  WorkItemTypeView,
} from '@/lib/wbs-api';
import {
  DEFAULT_PERT_WEIGHTS_VIEW,
  type EstimateMethod,
  type EstimateRoundingView,
  type PertWeightsView,
  type PlanOptimizationView,
  type ProjectApi,
  type SliceView,
  type StepView,
} from '@/lib/wbs-api';

import { type CellCards } from './cell-card-store';
import type { FocusIntent } from './live-editing';
import { type CommitOutcome, forgetRefusedDrafts } from './live-editing';
import {
  failureText,
  GONE,
  INVALID_REQUEST,
  NOTHING_TO_REDO,
  NOTHING_TO_UNDO,
  refusalSentence,
} from './plan-refusal';
import { type Toast } from './toasts';
import { dropDrafts, rowOfCellKey, stepOfCellKey, stepOfDraftKey } from './use-estimate-drafts';
import { toTree, type TreeRow } from './wbs-rows';

export interface WbsTableProps {
  projectId: string;
  api: ProjectApi;
  /**
   * What this project is called, for the export's header and its filename.
   *
   * Optional for the reason `subscribe` is: the table is driven by a fake in
   * tests and the picker that holds the name is not on screen there. Supplied
   * in the app — see {@link UNNAMED_PROJECT} for what an export says without it.
   */
  projectName?: string;
  /**
   * Opens a live subscription. Optional so the table can be tested without a
   * socket; supplied in the app.
   */
  subscribe?: (
    projectId: string,
    handlers: SubscriptionHandlers,
    baseline: number,
  ) => ProjectStream;
  /**
   * The saved-plan shelf, for the phone's `Plan actions` sheet — and rendered
   * **only** there, in the `cards` arm below.
   *
   * A `ReactNode` the page hands down rather than a component this file builds:
   * the shelf needs the checkpoint routes and the project the picker has open,
   * and both live in `ProjectPage`. Threading them here would give the table
   * two more props it never reads.
   *
   * Optional because the table is driven by a fake in tests and mounted on its
   * own in several of them. Absent, the sheet is exactly what it was.
   */
  savedPlansShelf?: ReactNode;
}

export interface SubscriptionHandlers {
  /** See `ProjectStreamOptions.onChange`: what the frame said changed, or `null`. */
  onChange: (changed?: string | null, seq?: number) => void;
  onConnectionChange: (connected: boolean) => void;
}

/**
 * How much of the plan a read has to fetch.
 *
 * The coordinator owns tree, steps, grouped directory and calendar markers.
 * These scopes adapt existing plan mutation callers to resource obligations;
 * marker mutations invalidate their separate resource directly.
 *
 * `'all'` is the default and the answer to anything this side does not
 * recognise. The two narrower scopes are claims about be-01's events, and each
 * is only sound because of something be-01 guarantees:
 *
 * - `'tree'` skips the vocabularies because a plan batch that mints a person or
 *   a tag holds the directory service's own announcement and sends it after the
 *   commit (`plan-commands.ts`: `announcements.hold` then `send(pending)`), so
 *   the directory change announces itself and is not folded silently into a
 *   `tree_replaced`.
 * - `'tree-and-steps'` adds the steps because that is what the three step
 *   events change, as `ProjectEvent`'s own JSDoc says.
 *
 * `directory_changed` and the capacity events are deliberately **not** narrowed:
 * a removed team takes its assignments and labels out of the tree with it, so
 * they are full reads.
 */
export type PlanReadScope = 'all' | 'tree' | 'tree-and-steps';

/**
 * One read of the tree, as far as the chart is concerned: the slices, the steps
 * they were placed under, and the names of everybody on them.
 *
 * All three arrive on the same request, and this type is what keeps them
 * arriving together — see {@link GanttPlan} for what happens to a drawing whose
 * parts came from different moments.
 */
export interface ChartRead {
  slices: SliceView[];
  steps: StepView[];
  people: AssignedPersonView[];
  /**
   * How far into a predecessor this plan's dependencies reach.
   *
   * Here rather than in a `useState` of its own for the reason `roles` is: the
   * chart draws each arrow out of the slice this names, so a reach from one
   * moment against slices from another draws an arrow the engine never placed.
   * They arrive in one payload and they are held as one.
   */
  depReach: DependencyReach;
  /**
   * The arithmetic the plan's days were computed with — the PERT coefficients
   * and the rounding one step's figure is charged at.
   *
   * Here for exactly the reason {@link ChartRead.depReach} is: the figures in
   * `slices` were produced by *these* weights and *this* rounding, and a
   * settings panel seeded from another moment would offer to "change" a value
   * the table is not showing. They arrive in one payload and are held as one.
   */
  pertWeights: PertWeightsView;
  estimateRounding: EstimateRoundingView;
  /** The optimizer state returned with the schedule, when the runtime is wired. */
  optimization?: PlanOptimizationView;
  /**
   * Which read this is: the coordinator's installed tree generation, and 0 before any has
   * landed.
   *
   * Carried here rather than kept in a ref because it is what
   * {@link GanttFaultBoundary} resets on — a fault caught while drawing one
   * read must clear when the next one arrives, and only a value that renders
   * can say a new one has.
   */
  generation: number;
}

/**
 * No read has landed yet: no slices, no roles, nobody, and no generation.
 *
 * The reach is the column's own default, which is what a project has unless it
 * asks otherwise — and with no slices to draw there is no arrow for it to place
 * either way.
 */
export const NO_CHART_READ: ChartRead = {
  slices: [],
  steps: [],
  people: [],
  depReach: 'whole-item',
  // The column defaults, which are what a project has unless it asks
  // otherwise — 1/4/1 and `ceil`, the same figures `libs/domain`'s
  // `DEFAULT_ESTIMATE_RULE` carries. With no slices to draw, nothing has been
  // computed with them either way.
  pertWeights: DEFAULT_PERT_WEIGHTS_VIEW,
  estimateRounding: 'ceil',
  generation: 0,
};

/**
 * No calendar markers — the state before the first read lands, and the state a
 * project with none stays in.
 *
 * Hoisted out of the component so the empty case is one object rather than a
 * new array on every render: `GanttPanel` takes `markers` straight into a
 * `useMemo` dependency list, and a fresh `[]` each time would rebuild the chip
 * layer on renders that changed nothing about it. `gantt-panel.tsx` keeps its
 * own `NO_MARKERS` for the same reason on the other side of the prop.
 */
const NO_MARKERS: readonly CalendarMarkerView[] = [];

/**
 * What a plan read holds while it is in flight, and after it has landed: the
 * rows, the chart's slices, the vocabularies, the undo stack and whether any
 * of it is stale.
 *
 * State rather than a query cache because this table has one project on screen
 * and a socket telling it when to read again — see {@link usePlanRead} for the
 * reading itself.
 */
export function usePlanReadState({ projectId }: { projectId: string }) {
  /**
   * The project this render belongs to, readable by work that outlives the
   * render which started it.
   *
   * Updated during render rather than in an effect: a click can land on the
   * newly rendered project before effects run, and stale work must already
   * know it no longer owns this table by then.
   */
  const activeProject = useRef(projectId);

  activeProject.current = projectId;

  const [workItems, setWorkItems] = useState<TreeRow[]>([]);

  /** The project whose whole tree most recently completed a successful read. */
  const treeReadProject = useRef<string | null>(null);

  /**
   * Everything the chart is drawn from, as **one** read delivered it.
   *
   * Replaced whole on every refetch, never patched, for the reason the rows
   * are: one edit can move slices of work items this component never touched —
   * a person freed here starts something over there — and guessing which would
   * be a second implementation of the engine.
   *
   * One state and not three, and that is the fix rather than a tidy-up.
   * `layOutGantt` refuses a payload whose slices name a step or a person it has
   * not got, which is exactly what this client held while the slices came from
   * `tree()` and the steps and names came from `steps()` and `listPeople()`:
   * four requests, four moments, and a peer deleting a step in between left a
   * chart that threw. Held together, they cannot disagree — there is no setter
   * that can move one without the others.
   *
   * The separate reads stay for what they are actually about: {@link steps}
   * heads the estimate columns and the steps dialog edits it, and
   * {@link people} is who the assignee picker can offer.
   */
  const [chartRead, setChartRead] = useState<ChartRead>(NO_CHART_READ);

  const [steps, setSteps] = useState<StepView[]>([]);

  /**
   * Whether the last refetch failed, leaving the tree on screen possibly
   * behind what be-01 holds.
   *
   * A state, so a banner rather than a toast, and it is the counterpart to
   * keeping the last good tree on screen: rows that may be stale and no way to
   * tell are worse than an empty table. Cleared by any refresh that lands —
   * the retry button's, an edit's, or a peer's change event.
   */
  const [treeMayBeStale, setTreeMayBeStale] = useState(false);

  const [busy, setBusy] = useState(false);

  const [connected, setConnected] = useState(true);

  const [scheduleError, setScheduleError] = useState<'cycle' | null>(null);

  const [estimateMethod, setEstimateMethod] = useState<EstimateMethod>('pert');

  /**
   * Whether this reader has anything to undo or redo, as of the last tree read.
   *
   * Read off the tree rather than tracked here. Both halves of the stack are
   * be-01's — a refused step throws its entry away, and a change of this
   * reader's own clears their redo branch — so a count kept in the browser
   * would be a second answer to a question that has one, and it would be wrong
   * in exactly the cases that matter.
   */
  const [stack, setStack] = useState({ undoable: false, redoable: false });

  /** The project's start date, or null while the plan is not on a calendar. */
  const [startDate, setStartDate] = useState<string | null>(null);

  /**
   * The global directory: every team and every person on this deployment.
   *
   * Global rather than per project — Dany's ask — so it is loaded once beside
   * the tree rather than filtered by anything.
   */
  const [teams, setTeams] = useState<TeamView[]>([]);

  /** The global tag vocabulary, for the facet's labels and the cell's picker. */
  const [tags, setTags] = useState<TagView[]>([]);

  /**
   * The global service vocabulary, for the third dimension's facet labels and —
   * from task 7.1 — its cell picker.
   *
   * Beside the tags and loaded on the same read for the same reason: a facet
   * that offers ids instead of names is a filter nobody can aim.
   */
  const [services, setServices] = useState<ServiceView[]>([]);

  const [workItemTypes, setWorkItemTypes] = useState<WorkItemTypeView[]>([]);

  /**
   * The external-system vocabulary, for the ref marks' names and the editor's
   * picker.
   *
   * Loaded with the other four and never added to: be-01 seeds this one with
   * exactly the names `systemOfUrl` can answer and offers no create, so a page
   * that has read it once has read all of it.
   */
  const [externalSystems, setExternalSystems] = useState<ExternalSystemView[]>([]);

  /**
   * How many of each team this plan may have at work at once, as be-01 sent it
   * with the tree.
   *
   * Off the tree read and not a request of its own: the dates on screen were
   * computed from these numbers, and a separately-fetched capacity could put a
   * number beside bars it does not explain. `wbs-api.ts` has the argument.
   */
  const [teamCapacities, setTeamCapacities] = useState<TeamCapacityView[]>([]);

  /**
   * What this plan calls its priority numbers — five rungs, most important first.
   *
   * Off the tree read for {@link teamCapacities}' reason and one of its own: no
   * date here was computed from the ladder, but every face draws every priority
   * through it, so a ladder fetched at a second moment would paint the wrong
   * label on every row rather than on one. `DEFAULT_PRIORITY_BANDS` is be-01's
   * answer for a plan nobody has configured, so this is empty only before the
   * first read has landed — which is the same moment the rows are empty.
   */
  const [priorityBands, setPriorityBands] = useState<PriorityBandView[]>([]);

  const [people, setPeople] = useState<PersonView[]>([]);
  /**
   * The calendar markers on this project — the list `GanttPanel` draws.
   *
   * **Its own state off its own read**, and not a member of `chartRead`, which
   * is `ProjectApi.listCalendarMarkers`'s own argument turned around: a marker
   * moves nothing in the schedule (task 4, axis-1), so folding it into the plan
   * would make every marker write a full tree reread and every tree reread
   * carry markers the table never looks at.
   *
   * The panel reports its four writes upward rather than performing them
   * ({@link GanttProps.onRenameMarker}) precisely so that this component — the
   * owner of the list — is the single place where a write and the redraw after
   * it can agree. Everything below is that owner.
   */
  const [markers, setMarkers] = useState<readonly CalendarMarkerView[]>(NO_MARKERS);
  return {
    markers,
    setMarkers,
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
  };
}

/**
 * Reading the plan, and everything that decides **when** to read it again: the
 * socket's events, a write's own answer, and the project changing under the
 * component.
 *
 * `refresh` takes a scope rather than always reading everything, because a step
 * rename and a tree replacement are different amounts of work and the socket
 * says which happened.
 */
export function usePlanRead({
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
  cellCards,
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
}: {
  setDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  projectId: string;
  activeProject: React.RefObject<string>;
  api: ProjectApi;
  setTreeMayBeStale: React.Dispatch<React.SetStateAction<boolean>>;
  setMarkers: React.Dispatch<React.SetStateAction<readonly CalendarMarkerView[]>>;
  setTeams: React.Dispatch<React.SetStateAction<TeamView[]>>;
  setTags: React.Dispatch<React.SetStateAction<TagView[]>>;
  setServices: React.Dispatch<React.SetStateAction<ServiceView[]>>;
  setWorkItemTypes: React.Dispatch<React.SetStateAction<WorkItemTypeView[]>>;
  setExternalSystems: React.Dispatch<React.SetStateAction<ExternalSystemView[]>>;
  setPeople: React.Dispatch<React.SetStateAction<PersonView[]>>;
  setWorkItems: React.Dispatch<React.SetStateAction<TreeRow[]>>;
  treeReadProject: React.RefObject<string | null>;
  rowPlacements: React.RefObject<ReadonlyMap<string, string>>;
  cellCards: CellCards;
  setChartRead: React.Dispatch<React.SetStateAction<ChartRead>>;
  setStack: React.Dispatch<React.SetStateAction<{ undoable: boolean; redoable: boolean }>>;
  setTeamCapacities: React.Dispatch<React.SetStateAction<TeamCapacityView[]>>;
  setPriorityBands: React.Dispatch<React.SetStateAction<PriorityBandView[]>>;
  setScheduleError: React.Dispatch<React.SetStateAction<'cycle' | null>>;
  setEstimateMethod: React.Dispatch<
    React.SetStateAction<'pert' | 'optimistic' | 'realistic' | 'pessimistic'>
  >;
  setStartDate: React.Dispatch<React.SetStateAction<string | null>>;
  setSteps: React.Dispatch<React.SetStateAction<StepView[]>>;
  pushToast: (toast: Toast) => void;
  subscribe:
    | ((projectId: string, handlers: SubscriptionHandlers, baseline: number) => ProjectStream)
    | undefined;
  setConnected: React.Dispatch<React.SetStateAction<boolean>>;
  focusIntent: React.RefObject<FocusIntent>;
  setBusy: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const ownerRef = useRef<PlanRefresh | null>(null);
  const activeApi = useRef(api);
  activeApi.current = api;

  /**
   * Settles this browser's own state against the steps be-01 just reported.
   *
   * A step that goes takes two things with it that are nobody's but this
   * client's, and be-01 can clean up neither:
   *
   * - the **estimate drafts**, keyed `rowId::stepId::point`. A half-typed trio
   *   for a step that has gone is a figure nobody can see, reach or finish,
   *   and it goes on counting as content — an otherwise empty row it belongs to
   *   can never be removed by Backspace again.
   * - the **held refusals**, keyed by cell, whose columns no longer exist —
   *   text nobody can ever resolve, held for the life of the page.
   *
   * `unfoldedSteps` is deliberately **not** settled here, and that is a finding
   * rather than an omission. The plan asked for it (agy #7) on the reading that
   * the set could hold a dead id; it can, and nothing can observe it,
   * because `columns` is built by mapping over `steps` and a dead id selects no
   * step to unfold. The sanitizer was written, its negative test watched
   * **passing** with the line deleted, and the line removed —
   * `openspec/changes/phases-ui/verify.md` has the run.
   *
   * The drafts sanitizer returns the object it was given when nothing changed.
   * `drafts` is not one of `columns`' dependencies, so this is about not
   * re-rendering every cell rather than about remounting them — but the rule is
   * the same one `sameSteps` keeps one line above, and stating it twice is
   * cheaper than the two of them drifting.
   *
   * A step change **does** cost the focus, and that is the accepted trade: the
   * columns really are different, the cells really are new elements, and the
   * person sees the caret leave the box at the moment the table changes shape.
   * What must not go with it is a draft be-01 refused, which is why the hold is
   * outside `CellInput` — see {@link refusedDrafts}.
   */
  const settleAgainstSteps = useCallback(
    (live: readonly StepView[]) => {
      const liveIds = new Set(live.map((step) => step.id));
      // Proof: this whole block deleted, `drops a half-typed figure for a step
      // that has gone` failed on `expected [ '010' ] to deeply equal []` — an
      // empty row nobody could remove, vetoed by a figure typed for a step that
      // was no longer there. Watched, 2026-08-09.
      setDrafts((current) => {
        const gone = new Set(
          Object.keys(current).filter((key) => {
            const stepId = stepOfDraftKey(key);
            return stepId !== null && !liveIds.has(stepId);
          }),
        );
        return gone.size === 0 ? current : dropDrafts(current, gone);
      });
      // Proof: this call deleted, `forgets a refusal held for a step that has
      // gone` failed on `expected '9' to be undefined`. Watched, 2026-08-09.
      forgetRefusedDrafts((cellKey) => {
        const stepId = stepOfCellKey(cellKey);
        return stepId !== null && !liveIds.has(stepId);
      });
    },
    [setDrafts],
  );

  const applySnapshot = useCallback(
    (
      snapshot: PlanRefreshSnapshot,
      applied: Record<'tree' | 'steps' | 'directory' | 'markers', number>,
    ) => {
      setTreeMayBeStale(snapshot.staleResources.length > 0);
      // Publish the first table with its column vocabulary. The tree anchor
      // alone would expose editors which the initial steps read then remounts.
      // Proof: removing this gate exposed a textarea instead of null in
      // `does not expose a first editor before its held column vocabulary installs`.
      if (snapshot.baseline === null) return;
      if (
        snapshot.directory.installed !== null &&
        snapshot.directory.installed.generation > applied.directory
      ) {
        const vocabulary = snapshot.directory.installed.value;
        applied.directory = snapshot.directory.installed.generation;
        setTeams(vocabulary.teams);
        setTags(vocabulary.tags);
        setServices(vocabulary.services);
        setWorkItemTypes(vocabulary.workItemTypes);
        setExternalSystems(vocabulary.externalSystems);
        setPeople(vocabulary.people);
      }
      if (snapshot.tree.installed !== null && snapshot.tree.installed.generation > applied.tree) {
        const tree = snapshot.tree.installed.value;
        applied.tree = snapshot.tree.installed.generation;
        const drawn = toTree(tree.workItems);
        setWorkItems(drawn);
        treeReadProject.current = projectId;
        // The open hover card, settled against the rows that just arrived. The
        // previous placements are read into a local **before** the ref is replaced:
        // React may run the updater below after this call returns, and reading the
        // ref from inside it would compare the new tree against itself and never
        // close anything.
        // Proof: this pair deleted, `closes the card when a peer moves the row it
        // is anchored to` failed on `expected <div role="tooltip" …/> to be null`.
        // Watched, 2026-08-09.
        const placements = placementsOf(drawn);
        const wasPlaced = rowPlacements.current;
        rowPlacements.current = placements;
        cellCards.updateHovered((open) => hoveredCellAfterRefresh(open, wasPlaced, placements));
        // On the same read as the rows and behind the same generation check: a
        // superseded read must not leave its slices under another read's rows.
        // Proof: written as `setSlices((current) => current.length === 0 ?
        // tree.slices : current)` — the refetch leaving the slices where the first
        // read put them — and `replaces the slices on every refetch, as it replaces
        // the rows` failed on `expected '2' to be '1'`: a second row on screen with
        // the one-row plan's slices still behind it; watched 2026-08-09.
        //
        // One call, so the chart's three parts can only ever be one payload's. The
        // steps and the names come from `tree` and **not** from `loadedSteps` or
        // `loadedPeople` below: those are three more requests, and a peer's step
        // delete landing between them is what used to hand `layOutGantt` a slice
        // under a step the plan no longer listed.
        setChartRead({
          slices: tree.slices,
          steps: tree.steps,
          people: tree.assignedPeople,
          depReach: tree.depReach,
          pertWeights: tree.pertWeights,
          estimateRounding: tree.estimateRounding,
          ...(tree.optimization === undefined ? {} : { optimization: tree.optimization }),
          generation: snapshot.tree.installed.generation,
        });
        setStack({ undoable: tree.undoable, redoable: tree.redoable });
        setTeamCapacities(tree.teamCapacities);
        setPriorityBands(tree.priorityBands);
        setScheduleError(tree.scheduleError);
        // Proof: renaming the shared response field to `planningMethod` made this
        // production screen fail with TS2339: `estimateMethod` does not exist on PlanRead.
        setEstimateMethod(tree.estimateMethod);
        setStartDate(tree.startDate);
      }
      if (
        snapshot.steps.installed !== null &&
        snapshot.steps.installed.generation > applied.steps
      ) {
        const loadedSteps = snapshot.steps.installed.value;
        applied.steps = snapshot.steps.installed.generation;
        setSteps((current) => (sameSteps(current, loadedSteps) ? current : [...loadedSteps]));
        settleAgainstSteps(loadedSteps);
      }
      if (
        snapshot.markers.installed !== null &&
        snapshot.markers.installed.generation > applied.markers
      ) {
        applied.markers = snapshot.markers.installed.generation;
        setMarkers(snapshot.markers.installed.value);
      }
    },
    [
      projectId,
      rowPlacements,
      setChartRead,
      setEstimateMethod,
      setExternalSystems,
      cellCards,
      setPeople,
      setPriorityBands,
      setScheduleError,
      setServices,
      setStack,
      setStartDate,
      setSteps,
      setTags,
      setTeamCapacities,
      setTeams,
      setTreeMayBeStale,
      setWorkItemTypes,
      setWorkItems,
      settleAgainstSteps,
      treeReadProject,
      setMarkers,
    ],
  );

  useEffect(() => {
    // Proof: reusing the disposed owner left zero subscriptions instead of one
    // in `creates a live second owner after StrictMode cleans up its first setup`.
    const owner = createPlanRefresh({ projectId, api });
    ownerRef.current = owner;
    const applied = { tree: 0, steps: 0, directory: 0, markers: 0 };
    let stream: ProjectStream | null = null;
    let streamSequence = -1;
    const isCurrent = () =>
      ownerRef.current === owner &&
      activeProject.current === projectId &&
      activeApi.current === api;
    const apply = () => {
      if (!isCurrent()) return;
      const snapshot = owner.getSnapshot();
      applySnapshot(snapshot, applied);
      if (subscribe !== undefined && snapshot.baseline !== null && stream === null) {
        // The existing socket is already registered during recovery. Reopening
        // here would turn every refused resume into another read/socket cycle.
        // Proof: restoring epoch replacement opened two sockets instead of one
        // in both `recovers a persistent %s ...` production-page cases.
        streamSequence = snapshot.baseline.seq;
        stream = subscribe(
          projectId,
          {
            onChange: (changed, seq) => {
              if (!isCurrent()) return;
              if (changed == null && seq === undefined) void owner.initialize();
              else void owner.invalidate({ resources: resourcesFor(changed), seq });
            },
            onConnectionChange: (connected) => {
              if (isCurrent()) setConnected(connected);
            },
          },
          snapshot.baseline.seq,
        );
      }
      if (snapshot.acknowledged > streamSequence) {
        stream?.seen(snapshot.acknowledged);
        streamSequence = snapshot.acknowledged;
      }
    };
    const stop = owner.subscribe(apply);
    void owner.initialize().then((outcome) => {
      if (!isCurrent() || outcome.status !== 'failed') return;
      for (const failure of outcome.failures)
        pushToast({ kind: 'error', text: failureText(failure.cause, 'load_failed') });
    });
    return () => {
      if (ownerRef.current === owner) ownerRef.current = null;
      stop();
      owner.dispose();
      stream?.unsubscribe();
    };
  }, [activeProject, api, projectId, applySnapshot, pushToast, setConnected, subscribe]);

  /** Awaits this invalidation's covering outcome; failures remain in the owner snapshot. */
  const refreshOrMarkStale = useCallback(
    async (scope: PlanReadScope = 'all'): Promise<void> => {
      const owner = ownerRef.current;
      if (owner === null || activeProject.current !== projectId || activeApi.current !== api)
        return;
      if (owner.getSnapshot().baseline === null && owner.getSnapshot().staleResources.length > 0)
        await owner.initialize();
      else
        await owner.invalidate({
          resources:
            scope === 'tree'
              ? ['tree']
              : scope === 'tree-and-steps'
                ? ['tree', 'steps']
                : ALL_RESOURCES,
        });
    },
    [activeProject, api, projectId],
  );

  /** A refused marker write also invalidates its list: the target may have disappeared. */
  const runMarkerWrite = useCallback(
    async (write: () => Promise<unknown>) => {
      const owner = ownerRef.current;
      if (owner === null) return;
      const isCurrent = () =>
        ownerRef.current === owner &&
        activeProject.current === projectId &&
        activeApi.current === api;
      try {
        await write();
      } catch (thrown) {
        if (!isCurrent()) return;
        pushToast({ kind: 'error', text: refusalSentence(thrown) });
      }
      // Proof: returning after the refusal left the deleted marker's span drawn
      // in `rereads a marker refused because a peer already deleted it`.
      if (isCurrent()) await owner.invalidate({ resources: ['markers'] });
    },
    [activeProject, api, projectId, pushToast],
  );

  /**
   * One edit: send it, then reread the tree.
   *
   * The two halves fail differently and are reported differently, which is the
   * whole of this change's rule. A refused request is an **event** — somebody
   * asked for something and did not get it — so it is a toast that stays until
   * it is read. A reread that failed is a **state**: the request landed, and
   * what is on screen may now be behind be-01, which is the banner.
   *
   * Nothing is cleared on the way in. The old version reset the error line
   * before every request, so the reason a rename was refused vanished the
   * moment anything else worked; toasts own their own lifecycle instead.
   * Proof: the clear put back at the top of this function, `keeps a failure on
   * screen when the next action succeeds` failed with the toast gone. Watched,
   * 2026-08-06.
   *
   * A refused action skips the reread deliberately: be-01 changed nothing, so
   * there is nothing new to read. **One refusal is the exception.**
   * {@link GONE} says the row this client acted on is not there any more, which
   * is a fact about the tree on screen rather than about the request — without
   * the reread the toast says a row is gone while the row stays on screen,
   * which is the worst of both.
   *
   * The verdict is returned as well as toasted, because a toast is a sentence
   * and some callers need the fact. `CellInput` is the one: a refused edit
   * exists only in the box it was typed into, and the box has to be told so it
   * can hold it against the next refetch (rule 4 there). A reread that failed
   * is still `landed` — the write happened, and the banner is what says the
   * screen may be behind.
   */
  const run = useCallback(
    async (action: () => Promise<void>): Promise<CommitOutcome> => {
      // Proof: guarding only projectId leaked one refusal toast into the new API
      // owner in `does not toast an old API mutation refusal into its replacement`.
      const owner = ownerRef.current;
      const isCurrent = () =>
        owner !== null &&
        ownerRef.current === owner &&
        activeProject.current === projectId &&
        activeApi.current === api;
      // Read here, synchronously, because this is the moment the gesture
      // happened. The intent compares it against where the focus is when the
      // refetch lands, and everything between the two is the window in which
      // the reader may have gone somewhere else.
      focusIntent.current.commandIssued();
      setBusy(true);
      try {
        try {
          await action();
        } catch (thrown: unknown) {
          // A refusal from a project the reader has left is not a refusal of
          // anything on the screen now. The old burst stops without putting
          // its toast or refetch into the next project.
          if (!isCurrent()) return 'refused';
          // Proof, two faults, both watched 2026-08-09. `refusalSentence`
          // replaced by `failureText`, `says a row that has gone is gone, and
          // rereads the tree that proves it` failed on `expected [ 'not_found' ]
          // to include 'That change could not be completed: …'`. The reread
          // below dropped, the same test failed on `expected [ '010', '020',
          // '030' ] to deeply equal [ '010', '020' ]`.
          pushToast({ kind: 'error', text: refusalSentence(thrown) });
          // Two refusals say the screen is behind rather than that the request
          // was wrong: {@link GONE}, and a body be-01 could not read. The
          // second is the sentence's own claim — {@link INVALID_REFUSAL} says
          // the plan was read again, and a sentence that says so without doing
          // it is the worst of both.
          const refusal = failureText(thrown, '');
          if (refusal === GONE || INVALID_REQUEST.has(refusal)) await refreshOrMarkStale();
          return 'refused';
        }
        if (isCurrent()) await refreshOrMarkStale();
        return 'landed';
      } finally {
        // The next project's write owns its busy state. An older completion
        // cannot clear the affordance while that write is still in flight.
        if (isCurrent()) setBusy(false);
      }
    },
    [activeProject, api, focusIntent, projectId, pushToast, refreshOrMarkStale, setBusy],
  );

  /**
   * One step along the undo stack, and the sentence that says what happened.
   *
   * Three outcomes, all of them said out loud, because a shortcut that
   * silently does nothing is worse than no shortcut. A step that worked is an
   * `info` — it is a fact to know, and it takes itself off. Both refusals are
   * errors that stay until they are read: the reader asked for something and
   * did not get it, and in the stale case somebody else's change is the reason.
   *
   * The tree is reread after a refusal too, not only after a success. be-01
   * throws away the entry it refused — it can never apply again — so what
   * there is left to undo has changed even though the plan has not.
   */
  const stepStack = useCallback(
    async (direction: 'undo' | 'redo') => {
      const owner = ownerRef.current;
      const isCurrent = () =>
        owner !== null &&
        ownerRef.current === owner &&
        activeProject.current === projectId &&
        activeApi.current === api;
      setBusy(true);
      try {
        let outcome;
        try {
          outcome = direction === 'undo' ? await api.undo(projectId) : await api.redo(projectId);
        } catch (thrown: unknown) {
          if (!isCurrent()) return;
          // The same register as `run`: be-01's two *modeled* refusals are read
          // out of the 409 below and get their own sentences; anything else is
          // a code, and a code is not a sentence.
          pushToast({ kind: 'error', text: refusalSentence(thrown) });
          return;
        }
        if (!isCurrent()) return;
        if (outcome.ok) {
          pushToast({
            kind: 'info',
            text: `${direction === 'undo' ? 'Undid' : 'Redid'}: ${outcome.done}${
              outcome.detail === null ? '' : ` — ${outcome.detail}`
            }`,
          });
        } else if (outcome.reason === 'nothing_to_undo') {
          pushToast({
            kind: 'error',
            text: direction === 'undo' ? NOTHING_TO_UNDO : NOTHING_TO_REDO,
          });
        } else {
          pushToast({
            kind: 'error',
            // be-01's own sentence about what moved, because a translation
            // here would be a second vocabulary for one set of refusals.
            text: `${direction === 'undo' ? 'That could not be undone' : 'That could not be put back'}: ${outcome.detail ?? 'the plan has changed since then.'}`,
          });
        }
        await refreshOrMarkStale();
      } finally {
        if (isCurrent()) setBusy(false);
      }
    },
    [activeProject, api, projectId, pushToast, refreshOrMarkStale, setBusy],
  );
  return { refreshOrMarkStale, run, stepStack, runMarkerWrite };
}

/**
 * Where each row of a freshly read plan sits: `parentId::line`, by row id, where
 * the line is its position in the order the table draws.
 *
 * A walk of the tree rather than a count of siblings, and round 4's finding 10
 * is the reason. "First child of 020" is unchanged by a peer moving 020 itself
 * — the branch and everything in it goes somewhere else on screen while every
 * row inside it reports the same parent and the same place among its siblings,
 * so the card travelled with the branch and stayed open on a line the pointer
 * was never on. The line is the thing that actually moved, and no ancestor can
 * move without changing it.
 *
 * The parent stays in the pair as well, for the move that changes no line:
 * outdenting a row leaves it where it was and shifts it left by an indent. The
 * root's parent is spelled `''`, which no id can collide with.
 *
 * The tree, not the flat read, because the flat read is in this order only by
 * be-01's promise. Walking what the table is about to draw asks nothing of the
 * caller, and a fake that reorders less carefully than be-01 does cannot make
 * this quietly agree with itself.
 */
export function placementsOf(rows: readonly TreeRow[]): ReadonlyMap<string, string> {
  const placements = new Map<string, string>();
  let line = 0;
  const walk = (row: TreeRow): void => {
    placements.set(row.id, `${row.parentId ?? ''}::${String(line)}`);
    line += 1;
    for (const child of row.subRows) walk(child);
  };
  for (const root of rows) walk(root);
  return placements;
}

/**
 * The hovered cell a freshly read tree still supports, or null.
 *
 * A hover card is an absolutely positioned child of one cell and the hover is
 * remembered as a row id, so a refresh that moves that row takes the card with
 * it — to a line the pointer is not on — and one that deletes the row leaves a
 * key pointing at nothing. Neither is a card anybody asked for, and the pointer
 * will not say so: it has not moved, so no `mouseleave` is coming (codex round
 * 3, finding 3).
 *
 * Same parent and same position, rather than "still exists": a create above the
 * hovered row moves it down a line without touching it, and the card would
 * follow the row while the pointer stayed where it was.
 *
 * Unchanged is the common case and it is the one that must not close anything:
 * every edit anybody makes to this plan refetches, so clearing on each read
 * would be a card nobody could hold open long enough to read.
 */
export function hoveredCellAfterRefresh(
  open: string | null,
  was: ReadonlyMap<string, string>,
  now: ReadonlyMap<string, string>,
): string | null {
  if (open === null) return null;
  const placed = now.get(rowOfCellKey(open));
  return placed !== undefined && placed === was.get(rowOfCellKey(open)) ? open : null;
}

/** Whether two step lists say the same thing, so an equal one can be discarded. */
export function sameSteps(a: readonly StepView[], b: readonly StepView[]): boolean {
  return (
    a.length === b.length && a.every((step, i) => step.id === b[i]?.id && step.name === b[i]?.name)
  );
}
