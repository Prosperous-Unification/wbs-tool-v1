import type { DependencyReach } from '@wbs/domain/dependency-reach';
import type * as React from 'react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import type { ProjectStream } from '@/lib/project-stream';
import type {
  AssignedPersonView,
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
  type ProjectApi,
  type SliceView,
  type StepView,
} from '@/lib/wbs-api';

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
  subscribe?: (projectId: string, handlers: SubscriptionHandlers) => ProjectStream;
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
  onChange: (changed?: string | null) => void;
  onConnectionChange: (connected: boolean) => void;
}

/**
 * How much of the plan a read has to fetch.
 *
 * `refresh` reads eight things: the tree, the project's steps, and six global
 * vocabularies. Most of those cannot have changed for most events, and the
 * socket used to start all eight for every one of them — so a peer holding a
 * key issued eight requests per keystroke.
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
 * Which reads a frame's event needs.
 *
 * Unknown is not OK: an event this build has never heard of, and a frame that
 * said nothing, both read everything. Narrowing is opt-in per known kind, so a
 * new `ProjectEvent` added in be-01 is correct here before anybody edits this.
 */
export function readScopeFor(changed: string | null | undefined): PlanReadScope {
  if (changed === 'tree_replaced') return 'tree';
  if (changed === 'step_added' || changed === 'step_renamed' || changed === 'step_removed') {
    return 'tree-and-steps';
  }
  return 'all';
}

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
  /**
   * Which read this is: `refresh`'s own generation, and 0 before any has
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

/** Coordinates the table’s plan read state and actions. */
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
  return {
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

/** Coordinates the table’s plan read state and actions. */
export function usePlanRead({
  setDrafts,
  projectId,
  activeProject,
  api,
  setTreeMayBeStale,
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
}: {
  setDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  projectId: string;
  activeProject: React.MutableRefObject<string>;
  api: ProjectApi;
  setTreeMayBeStale: React.Dispatch<React.SetStateAction<boolean>>;
  setTeams: React.Dispatch<React.SetStateAction<TeamView[]>>;
  setTags: React.Dispatch<React.SetStateAction<TagView[]>>;
  setServices: React.Dispatch<React.SetStateAction<ServiceView[]>>;
  setWorkItemTypes: React.Dispatch<React.SetStateAction<WorkItemTypeView[]>>;
  setExternalSystems: React.Dispatch<React.SetStateAction<ExternalSystemView[]>>;
  setPeople: React.Dispatch<React.SetStateAction<PersonView[]>>;
  setWorkItems: React.Dispatch<React.SetStateAction<TreeRow[]>>;
  treeReadProject: React.MutableRefObject<string | null>;
  rowPlacements: React.MutableRefObject<ReadonlyMap<string, string>>;
  setHoveredCell: React.Dispatch<React.SetStateAction<string | null>>;
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
  subscribe: ((projectId: string, handlers: SubscriptionHandlers) => ProjectStream) | undefined;
  setConnected: React.Dispatch<React.SetStateAction<boolean>>;
  focusIntent: React.MutableRefObject<FocusIntent>;
  setBusy: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const latestRefresh = useRef(0);

  /**
   * The live subscription, so a refresh can tell it where the read landed.
   *
   * A ref rather than state: reporting the sequence must not re-render, and the
   * stream outlives every render between subscribe and unsubscribe.
   */
  const stream = useRef<ProjectStream | null>(null);

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

  const refresh = useCallback(
    async (scope: PlanReadScope = 'all') => {
      // An action from the project shown before the latest render can finish
      // afterwards. It may finish its server request, but it no longer gets a
      // read generation or a write into this project's screen.
      if (projectId !== activeProject.current) return;
      // Every mutation and every socket event starts a refresh, and they can
      // finish out of order — an earlier one landing last would replace the table
      // with a tree older than what is on screen, with nothing guaranteed to
      // arrive afterwards and repair it. Only the newest request may write.
      const generation = latestRefresh.current + 1;
      latestRefresh.current = generation;
      // `null` where the scope says this read does not need that request. The
      // vocabularies stay in one nested `Promise.all` rather than becoming six
      // ternaries, so they are still issued in one breath when they are issued at
      // all — which is what the five comments below are about.
      const [tree, loadedSteps, loadedVocabularies] = await Promise.all([
        api.tree(projectId),
        scope === 'tree' ? null : api.steps(projectId),
        scope === 'all'
          ? Promise.all([
              api.listTeams(),
              // Beside the teams rather than behind them: both are global lists the
              // pickers need before a reader can tick anything, and a second round trip
              // would put the tag facet a frame behind the team one.
              api.listTags(),
              // And the third dimension in the same breath, for that reason a third
              // time: the service facet names its options out of this list.
              api.listServices(),
              // And the fourth, a fourth time. Loaded even though the column is hidden
              // by default: a reader who turns Types on from `Columns` gets a picker
              // that already has the vocabulary, rather than one that is empty until the
              // next refresh — and the type facet is built from this list the same way.
              api.listWorkItemTypes(),
              // And the fifth, on the same read for the same reason: the ref marks name
              // their system out of this list, so a tree that arrived first would draw a
              // row's links as `other` for a frame.
              api.listExternalSystems(),
              api.listPeople(),
            ])
          : null,
      ]);
      if (projectId !== activeProject.current) return;
      if (generation !== latestRefresh.current) return;
      // This read landed, so whatever the last failed one left behind is over.
      // After the generation check, not before: a superseded read must not
      // vouch for a tree it is about to throw away, and the newest read is the
      // one entitled to say the screen is current.
      // Proof: removed, `raises the stale-tree banner when a socket refetch
      // fails` and `clears the banner on a later successful refetch from any
      // path` both failed with the banner still up after a clean reread.
      // Watched, 2026-08-06.
      setTreeMayBeStale(false);
      if (loadedVocabularies !== null) {
        const [
          loadedTeams,
          loadedTags,
          loadedServices,
          loadedWorkItemTypes,
          loadedExternalSystems,
          loadedPeople,
        ] = loadedVocabularies;
        setTeams(loadedTeams);
        setTags(loadedTags);
        setServices(loadedServices);
        setWorkItemTypes(loadedWorkItemTypes);
        setExternalSystems(loadedExternalSystems);
        setPeople(loadedPeople);
      }
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
      setHoveredCell((open) => hoveredCellAfterRefresh(open, wasPlaced, placements));
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
        generation,
      });
      setStack({ undoable: tree.undoable, redoable: tree.redoable });
      setTeamCapacities(tree.teamCapacities);
      setPriorityBands(tree.priorityBands);
      setScheduleError(tree.scheduleError);
      setEstimateMethod(tree.estimateMethod);
      setStartDate(tree.startDate);
      // Replaced only when the steps actually differ. Every read returns a fresh
      // array, and `steps` is the one dependency `columns` still has — so a new
      // array on every refresh rebuilt every column definition, which is how a
      // stranger's edit used to take the focus of whoever was mid-word.
      if (loadedSteps !== null) {
        setSteps((current) => (sameSteps(current, loadedSteps) ? current : loadedSteps));
        settleAgainstSteps(loadedSteps);
      }
      // Reported after the generation check, so a superseded read cannot move the
      // resume point to a moment whose rows were thrown away.
      stream.current?.seen(tree.seq);
    },
    [
      activeProject,
      api,
      projectId,
      rowPlacements,
      setChartRead,
      setEstimateMethod,
      setExternalSystems,
      setHoveredCell,
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
    ],
  );

  /**
   * Rereads the tree, and raises the stale banner instead of throwing when
   * that fails.
   *
   * The last good tree stays on screen — clearing it would lose the reader's
   * place over a blip — and the banner is what stops that being a silent lie
   * about how current the rows are. Never rejects, deliberately: callers that
   * have their own refusals to report (`dependOn`) must still report them
   * after a failed reread.
   */
  const refreshOrMarkStale = useCallback(
    async (scope: PlanReadScope = 'all') => {
      try {
        await refresh(scope);
      } catch {
        // The reason is not shown. It is be-01's word for a network failure the
        // reader did not cause and cannot act on beyond retrying, and the banner
        // already says the one thing they can do about it.
        //
        // Proof: emptied to the silent catch this replaced, four of the block's
        // tests failed — `raises the stale-tree banner when a socket refetch
        // fails`, `clears the banner on a later successful refetch from any
        // path`, `raises the banner when the refetch after an edit fails` and
        // `shows both the refusal and the banner when the refetch failed too`.
        // Watched, 2026-08-06.
        setTreeMayBeStale(true);
      }
    },
    [refresh, setTreeMayBeStale],
  );

  useEffect(() => {
    void refresh().catch((thrown: unknown) => {
      // The first read, which is different from a failed reread: there is no
      // last good tree to be stale, so this is an event to report rather than
      // a state to sit under. "This plan may be out of date" over an empty
      // table would be a sentence about a plan that never arrived.
      //
      // Not `refusalSentence`: nothing was refused. This is the first read of
      // the plan failing — a network word, not a verdict on a change somebody
      // asked for — and "That change could not be completed" would name a
      // change nobody made.
      pushToast({ kind: 'error', text: failureText(thrown, 'load_failed') });
    });
  }, [refresh, pushToast]);

  // Someone else's edit refetches rather than patching: a create or move can
  // renumber rows this client never touched.
  useEffect(() => {
    if (subscribe === undefined) return undefined;
    const opened = subscribe(projectId, {
      onChange: (changed) => {
        // No toast: nobody asked for this read, so nothing of theirs was
        // refused. What it can leave behind is a tree that has fallen behind,
        // and that is the banner's job.
        void refreshOrMarkStale(readScopeFor(changed));
      },
      onConnectionChange: setConnected,
    });
    stream.current = opened;
    return () => {
      opened.unsubscribe();
      stream.current = null;
    };
  }, [subscribe, projectId, refreshOrMarkStale, setConnected]);

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
      const issuedFor = projectId;
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
          if (activeProject.current !== issuedFor) return 'refused';
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
        if (activeProject.current === issuedFor) await refreshOrMarkStale();
        return 'landed';
      } finally {
        // The next project's write owns its busy state. An older completion
        // cannot clear the affordance while that write is still in flight.
        if (activeProject.current === issuedFor) setBusy(false);
      }
    },
    [activeProject, focusIntent, projectId, pushToast, refreshOrMarkStale, setBusy],
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
      setBusy(true);
      try {
        let outcome;
        try {
          outcome = direction === 'undo' ? await api.undo(projectId) : await api.redo(projectId);
        } catch (thrown: unknown) {
          // The same register as `run`: be-01's two *modeled* refusals are read
          // out of the 409 below and get their own sentences; anything else is
          // a code, and a code is not a sentence.
          pushToast({ kind: 'error', text: refusalSentence(thrown) });
          return;
        }
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
        setBusy(false);
      }
    },
    [api, projectId, pushToast, refreshOrMarkStale, setBusy],
  );
  return { refreshOrMarkStale, run, stepStack };
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
