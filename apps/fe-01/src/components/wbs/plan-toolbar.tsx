import type { Row } from '@tanstack/react-table';
import { type ExpandedState } from '@tanstack/react-table';
import type { DependencyReach } from '@wbs/domain/dependency-reach';
import type { EffectiveTeams } from '@wbs/domain/effective-team';
import type * as React from 'react';
import {
  type CSSProperties,
  type ReactNode,
  useDeferredValue,
  useEffect,
  useId,
  useState,
} from 'react';

import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { PersonView, PriorityBandView, TeamCapacityView, TeamView } from '@/lib/wbs-api';
import { isEstimateMethod, type ProjectApi, type StepView } from '@/lib/wbs-api';

import { MenuControl } from './actions-menu';
import { useClosedByPointerOutside } from './close-on-outside-pointer';
import { DateField } from './date-field';
import { type CommitOutcome } from './live-editing';
import type { PlanTableFeatures } from './plan-columns/column';
import type { EstimateGaps } from './plan-completeness';
import { describeGaps } from './plan-completeness';
import { isSectionMode, SECTION_MODES } from './plan-mermaid';
import { type PlanRenderRow } from './plan-render-rows';
import type { PlanRenderer } from './plan-renderer';
import { TAKES_THE_FOCUS } from './plan-toolbar-sheet';
import { ProjectSettingsModal } from './project-settings-modal';
import type { SavedView } from './remembered-layout';
import {
  rememberHiddenColumns,
  rememberMermaidSectionMode,
  rememberSavedViews,
} from './remembered-layout';
import { type FrameLayoutState } from './table-frame';
import { teamsOnThePlan } from './teams-panel';
import { ArrangeIcon, CollapseIcon, ExpandIcon, KeyboardIcon } from './toolbar-icons';
import type { TreeNarrowing } from './tree-search';
import {
  type FacetCriteria,
  type FilterCriteria,
  type FilterLabels,
  filterWords,
  isFiltering,
  NO_FACETS,
} from './tree-search';
import type { FacetOption } from './use-plan-filter';
import { facetsChosen, toggledIn } from './use-plan-filter';
import type { ChartRead, PlanReadScope } from './use-plan-read';
import { type TreeRow } from './wbs-rows';

/**
 * The six facets a reader can narrow the plan by, beside the Find box.
 *
 * **A `<details>` and not a positioned popover**, for the reason
 * `plan-cards.tsx`'s step breakdown is one: it needs no measurement, no
 * pointer-type guard and no dismiss handler, and a tap is what opens one
 * already — which is what makes this control work unchanged inside the phone's
 * `Plan actions` sheet, where a `<summary>` and a checkbox are not the
 * `<button>` that closes it (`closingControlIn`).
 *
 * **Every list is the plan's own.** The teams are the effective teams somebody
 * on this plan carries, the people are the ones be-01 says are assigned on it,
 * the bands are this project's ladder and the steps are its steps. A facet
 * offering a value no row has is a filter whose only possible answer is an
 * empty table.
 *
 * The narrowing itself is not here and must not be: this writes criteria, and
 * `narrowTree` is the one thing that reads them.
 */
export function FilterFacets({
  facets,
  setFacets,
  teams,
  tags,
  services,
  people,
  bands,
  steps,
  ownershipKnown,
  membershipKnown,
}: {
  facets: FacetCriteria;
  setFacets: (next: FacetCriteria) => void;
  teams: readonly FacetOption[];
  tags: readonly FacetOption[];
  services: readonly FacetOption[];
  people: readonly FacetOption[];
  bands: readonly FacetOption[];
  steps: readonly FacetOption[];
  /**
   * Whether any team owns any service — the directory fact `builtByNonOwner`
   * is asked against.
   *
   * False is the state the deployment ships in (the map has no seed data, by
   * the proposal's non-goal), and in it the signal does not mean "nothing is
   * built by a non-owner" — it flags **every** row carrying a team and a
   * service, because no team owns anything. Offering the box there would put a
   * marker on most of a plan on the strength of a directory nobody has filled
   * in, which is the failure `label-mismatch.ts` exists to argue against. The
   * design's first risk, mitigated by saying so instead of by ticking.
   */
  ownershipKnown: boolean;
  /** The same fact for the second signal: whether anybody belongs to any team. */
  membershipKnown: boolean;
}) {
  const chosen = facetsChosen(facets);
  /** One group of tick boxes, or nothing at all where the plan offers none. */
  const group = (
    title: string,
    kind: string,
    options: readonly FacetOption[],
    picked: readonly string[],
    take: (next: string[]) => FacetCriteria,
  ): ReactNode =>
    options.length === 0 ? null : (
      <fieldset data-facet-group={kind} className="mb-2 border-0 p-0">
        <legend className="text-muted-foreground mb-1 text-xs font-semibold">{title}</legend>
        {options.map((option) => (
          <label key={option.id} className="flex min-h-6 items-center gap-1.5">
            <input
              type="checkbox"
              // Named by its facet as well as its value: a team and a person
              // may share a name, and two boxes with one label is a control
              // neither a reader nor a test can aim at.
              aria-label={`${title} ${option.label}`}
              checked={picked.includes(option.id)}
              onChange={() => {
                setFacets(take(toggledIn(picked, option.id)));
              }}
            />
            <span className="truncate">{option.label}</span>
          </label>
        ))}
      </fieldset>
    );

  /**
   * One mismatch signal's box, with the reason it cannot be asked yet where a
   * reader will read it.
   *
   * **Disabled only while it is not already ticked.** A view saved when the
   * directory had ownership in it, reopened after somebody emptied the map,
   * would otherwise show a ticked box that cannot be unticked and a table with
   * nothing in it — a filter a reader cannot leave. Ticked wins: the box stays
   * live so it can be turned off, and the hint below still says why it now
   * finds nothing.
   *
   * `title` rather than a paragraph under the label, because this panel is 56
   * units wide and two sentences of hint per box push the State group off the
   * bottom of a phone's sheet. The same sentence is also the box's accessible
   * description, so it is not a mouse-only explanation.
   */
  const signal = (
    label: string,
    what: string,
    ticked: boolean,
    askable: boolean,
    why: string,
    take: (next: boolean) => FacetCriteria,
  ): ReactNode => {
    const off = !askable && !ticked;
    // `aria-describedby` at a visually-hidden span rather than
    // `aria-description`, which `jsx-a11y/role-supports-aria-props` refuses on
    // a checkbox — the attribute is ARIA 1.3 and the implicit role's property
    // list is 1.2. Observed, not assumed: the `aria-description` spelling was
    // this file's only lint error at a8ad8bd. The described-by spelling has
    // been supported everywhere since forever and reads the same to a screen
    // reader. Id derived from the label the same way `waitsForId` is derived
    // from the row id — the panel renders once, and the two labels differ.
    const hint = `facet-why-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    return (
      <label
        className={`flex min-h-6 items-center gap-1.5 ${off ? 'text-muted-foreground' : ''}`}
        // `why` is a refusal about this project — nothing in it is askable — so
        // it opens at once; `what` says what ticking the box does, and waits.
        {...(off ? { 'data-fact': why } : { 'data-hint': what })}
      >
        <input
          type="checkbox"
          aria-label={label}
          aria-describedby={hint}
          checked={ticked}
          disabled={off}
          onChange={() => {
            setFacets(take(!ticked));
          }}
        />
        <span>{label.replace(' only', '')}</span>
        <span id={hint} className="sr-only">
          {off ? why : what}
        </span>
      </label>
    );
  };

  return (
    <details ref={useClosedByPointerOutside()} data-facets className="relative">
      <summary
        className="border-input h-8 cursor-pointer rounded-md border px-2 py-1 text-xs select-none"
        data-hint="Narrow the plan to the rows carrying these — the table, the chart and the cards together"
      >
        Filters{chosen > 0 ? ` (${String(chosen)})` : ''}
      </summary>
      {/*
        Over the plan rather than in the toolbar's flow: this row already wraps
        at 1245px of controls, and a panel opening inside it would push the
        table down the page every time somebody looked at what was ticked.
      */}
      <div
        data-facet-panel
        className="bg-popover absolute z-50 mt-1 max-h-80 w-56 overflow-y-auto rounded-md border p-3 text-sm shadow-md"
      >
        {group('Team', 'team', teams, facets.teamIds, (teamIds) => ({ ...facets, teamIds }))}
        {/*
          Directly under Team, because the two answer the neighbouring questions
          — who does the work, and what kind of thing it is — and a reader
          narrowing by one usually wants the other in view.
        */}
        {group('Tag', 'tag', tags, facets.tagIds, (tagIds) => ({ ...facets, tagIds }))}
        {/*
          The third label dimension, beside the other two and after them: Team,
          Tag and Service are one question asked three ways, and a reader
          narrowing by one wants the others in view. Like both of them it
          disappears when the plan carries no services at all — `group` returns
          nothing for an empty list.
        */}
        {group('Service', 'service', services, facets.serviceIds, (serviceIds) => ({
          ...facets,
          serviceIds,
        }))}
        {group('Assignee', 'assignee', people, facets.assigneeIds, (assigneeIds) => ({
          ...facets,
          assigneeIds,
        }))}
        {group('Priority', 'priority', bands, facets.priorityBands, (priorityBands) => ({
          ...facets,
          priorityBands,
        }))}
        {group('Estimated for', 'step', steps, facets.estimatedStepIds, (estimatedStepIds) => ({
          ...facets,
          estimatedStepIds,
        }))}
        <fieldset data-facet-group="state" className="mb-2 border-0 p-0">
          <legend className="text-muted-foreground mb-1 text-xs font-semibold">State</legend>
          <label className="flex min-h-6 items-center gap-1.5">
            <input
              type="checkbox"
              aria-label="Unestimated only"
              checked={facets.unestimated}
              onChange={() => {
                setFacets({ ...facets, unestimated: !facets.unestimated });
              }}
            />
            {/*
              The readiness badge's own count, said as a filter: the same
              `gaps.leaves` the button beside it reports, so the two cannot
              describe two different plans.
            */}
            <span>Unestimated</span>
          </label>
          <label className="flex min-h-6 items-center gap-1.5">
            <input
              type="checkbox"
              aria-label="Critical path only"
              checked={facets.critical}
              onChange={() => {
                setFacets({ ...facets, critical: !facets.critical });
              }}
            />
            <span>On the critical path</span>
          </label>
        </fieldset>
        {/*
          The two mismatch signals, in a group of their own and not in `State`.
          Every box above narrows by something a row *carries*; these two narrow
          by something a row and the **directory** disagree about, which is a
          different question and reads as one.
        */}
        <fieldset data-facet-group="mismatch" className="mb-2 border-0 p-0">
          <legend className="text-muted-foreground mb-1 text-xs font-semibold">Mismatch</legend>
          {signal(
            'Built by non-owner only',
            'Rows whose effective team does not own their effective service.',
            facets.builtByNonOwner,
            ownershipKnown,
            'No team owns a service yet — set that on the team rows in the directory.',
            (builtByNonOwner) => ({ ...facets, builtByNonOwner }),
          )}
          {signal(
            'Assigned outside the team only',
            "Rows whose assignee is not a member of the row's effective team.",
            facets.assignedOutsideTeam,
            membershipKnown,
            'Nobody belongs to a team yet — set that on the people in the directory.',
            (assignedOutsideTeam) => ({ ...facets, assignedOutsideTeam }),
          )}
        </fieldset>
        {/*
          Offered only while there is something to forget, the same bargain
          `Reset layout` makes: a control that provably does nothing reads as a
          broken one. It clears the ticks and not the Find box — Escape in the
          box is how the typed half is left, and one control undoing the other's
          work is how a reader loses a query they were still using.
        */}
        {chosen > 0 && (
          <Button
            variant="outline"
            size="sm"
            type="button"
            data-hint="Untick every filter. The Find box is left as it is."
            onClick={() => {
              setFacets(NO_FACETS);
            }}
          >
            Clear filters
          </Button>
        )}
      </div>
    </details>
  );
}

export const COLUMN_LABELS: ReadonlyMap<string, string> = new Map([
  ['refs', 'Links'],
  ['depends', 'Depends on'],
  ['priority', 'Priority'],
  ['team', 'Teams'],
  ['tag', 'Tags'],
  ['service', 'Services'],
  ['type', 'Types'],
  ['in-parallel', 'People at once'],
  ['final-total', 'Days'],
  ['not-before', 'Not before'],
  ['deadline', 'Deadline'],
  ['start', 'Start'],
  ['finish', 'End'],
  ['float', 'Slack'],
]);

/**
 * The Columns control: one tick box per column a reader may hide, and one per
 * step, in the order the table renders them. Ticked is on screen.
 *
 * A `<details>` for the reason {@link FilterFacets} is one — no measurement,
 * no dismiss handler, and it works unchanged inside the phone's `Plan actions`
 * sheet. What it writes is the hide-list {@link rememberedHiddenColumns}
 * reads; the table itself is the one reader of that list, through the
 * `columns` memo, and this control never touches a column definition.
 *
 * Each row is a `<label>` wrapping its box — the shape the phone sheet's 44px
 * floor is written on — with `htmlFor` as well, so a test can read the panel
 * label-by-label off `label[for]`.
 */
export function ColumnsControl({
  offered,
  hiddenColumnIds,
  onToggle,
}: {
  offered: readonly { id: string; label: string }[];
  hiddenColumnIds: readonly string[];
  onToggle: (columnId: string) => void;
}) {
  const prefix = useId();
  return (
    <details ref={useClosedByPointerOutside()} data-columns className="relative">
      <summary
        className="border-input h-8 cursor-pointer rounded-md border px-2 py-1 text-xs select-none"
        data-hint="Choose which columns are on the table. Number, Name and the row's controls always are."
      >
        Columns
      </summary>
      <div
        data-columns-panel
        className="bg-popover absolute z-50 mt-1 max-h-80 w-56 overflow-y-auto rounded-md border p-3 text-sm shadow-md"
      >
        {offered.map(({ id, label }) => {
          const boxId = `${prefix}-${id}`;
          // A label **wrapping** its box, as the facet rows are: on a phone the
          // sheet's 44px floor (`styles.css`, `label:has(> input[type='checkbox'])`)
          // is written on exactly that shape, and the row is the tap target.
          // `htmlFor` as well, so the name can be read off `label[for]`.
          return (
            <label key={id} htmlFor={boxId} className="flex min-h-6 items-center gap-1.5">
              <input
                id={boxId}
                type="checkbox"
                checked={!hiddenColumnIds.includes(id)}
                onChange={() => {
                  onToggle(id);
                }}
              />
              <span className="truncate">{label}</span>
            </label>
          );
        })}
      </div>
    </details>
  );
}

/**
 * Named filters this browser has saved for this project — R10 F4, beside
 * {@link FilterFacets} because naming a filter and ticking one are the same
 * act's two moments.
 *
 * **Narrow, not highlight**, same as the filter itself: picking a saved view
 * writes the Find box and the ticks, exactly as if a reader had typed and
 * ticked it themselves, and {@link narrowTree} is the one thing that reads
 * what a view leaves behind. Nothing here holds a narrowed tree of its own.
 *
 * Save is offered only while something is actually being asked of the plan —
 * the same bargain `Clear filters` makes: a view named for the whole,
 * unfiltered plan has nothing to be picked back to, because opening a project
 * already shows the whole plan.
 */
export function SavedViews({
  views,
  current,
  labels,
  onSave,
  onApply,
  onDelete,
}: {
  views: readonly SavedView[];
  current: FilterCriteria;
  labels: FilterLabels;
  onSave: (name: string) => void;
  onApply: (view: SavedView) => void;
  onDelete: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const filtering = isFiltering(current);
  const canSave = filtering && name.trim() !== '';
  return (
    <details ref={useClosedByPointerOutside()} data-saved-views className="relative">
      <summary
        className="border-input h-8 cursor-pointer rounded-md border px-2 py-1 text-xs select-none"
        data-hint="Name the current filter, or pick one already named"
      >
        Views{views.length > 0 ? ` (${String(views.length)})` : ''}
      </summary>
      <div
        data-saved-views-panel
        className="bg-popover absolute z-50 mt-1 max-h-80 w-64 overflow-y-auto rounded-md border p-3 text-sm shadow-md"
      >
        <div className="mb-2 flex gap-1.5">
          <Input
            className="h-8 flex-1 text-xs"
            aria-label="Name this view"
            placeholder="Name this view…"
            value={name}
            onChange={(e) => {
              setName(e.currentTarget.value);
            }}
          />
          <Button
            variant="outline"
            size="sm"
            type="button"
            disabled={!canSave}
            // What the button does while there is something to save, and why it
            // is off while there is not — the second is about the plan in front
            // of the reader, so it does not wait.
            {...(filtering
              ? { 'data-hint': 'Save the Find box and the ticked filters under this name' }
              : { 'data-fact': 'Nothing is filtered — there is no view to name' })}
            onClick={() => {
              onSave(name.trim());
              setName('');
            }}
          >
            Save
          </Button>
        </div>
        {views.length === 0 ? (
          <p className="text-muted-foreground text-xs">No saved views yet.</p>
        ) : (
          <ul>
            {views.map((view) => {
              // What the view asks of the plan, said the same way the
              // filtered export's `Scope` line says it — one account of a
              // filter, not two that could disagree.
              const words = filterWords(view.criteria, labels);
              return (
                <li key={view.id} className="flex items-center gap-1">
                  <button
                    type="button"
                    className="min-h-7 flex-1 truncate text-left text-xs underline-offset-2 hover:underline"
                    data-fact={words.length > 0 ? words.join('; ') : view.name}
                    onClick={() => {
                      onApply(view);
                    }}
                  >
                    {view.name}
                  </button>
                  <Button
                    variant="ghost"
                    size="square"
                    type="button"
                    aria-label={`Delete view ${view.name}`}
                    data-hint="Forget this view. What it narrows to is untouched."
                    onClick={() => {
                      onDelete(view.id);
                    }}
                  >
                    <span aria-hidden="true">✕</span>
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </details>
  );
}

/**
 * The plan's toolbar, for both faces of the app: the desktop bar and the phone
 * sheet render this one component with the same props.
 *
 * Every prop is already resolved — nothing here reads the plan, and nothing
 * here decides what a control means. That is what lets the two renderers
 * differ only in where the controls are put.
 */
export function PlanToolbar({
  criteria,
  scheduleError,
  arrangeBySchedule,
  freezeMenuOpen,
  setFreezeMenuOpen,
  busy,
  run,
  api,
  projectId,
  addWorkItem,
  filtering,
  setExpanded,
  ganttOpen,
  setGanttOpen,
  renderer,
  teams,
  teamCapacities,
  flat,
  effectiveTeams,
  refreshOrMarkStale,
  priorityBands,
  steps,
  hiddenColumnIds,
  frameState,
  people,
  chartRead,
  estimateMethod,
  commitQuery,
  facets,
  setFacets,
  facetTeams,
  facetTags,
  facetServices,
  facetPeople,
  facetBands,
  facetSteps,
  ownershipKnown,
  membershipKnown,
  savedViews,
  filterLabels,
  setSavedViews,
  setStoredHiddenColumns,
  offeredColumns,
  toggleColumn,
  shownRows,
  search,
  gaps,
  walkToNextGap,
  stack,
  stepStack,
  setCheatSheetOpen,
  exportAvailable,
  copyAsMarkdown,
  copyAsMermaid,
  downloadCsv,
  downloadMermaidDocument,
  downloadChartSvg,
  downloadOnScreen,
  mermaidSectionMode,
  setMermaidSectionMode,
  startDate,
  chooseEstimateMethod,
}: {
  criteria: FilterCriteria;
  freezeMenuOpen: boolean;
  setFreezeMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  busy: boolean;
  run: (action: () => Promise<void>) => Promise<CommitOutcome>;
  api: ProjectApi;
  projectId: string;
  addWorkItem: () => void;
  filtering: boolean;
  setExpanded: React.Dispatch<React.SetStateAction<ExpandedState>>;
  ganttOpen: boolean;
  setGanttOpen: React.Dispatch<React.SetStateAction<boolean>>;
  renderer: PlanRenderer;
  teams: TeamView[];
  teamCapacities: TeamCapacityView[];
  flat: TreeRow[];
  effectiveTeams: Map<string, EffectiveTeams>;
  refreshOrMarkStale: (scope?: PlanReadScope) => Promise<void>;
  priorityBands: PriorityBandView[];
  steps: StepView[];
  hiddenColumnIds: string[];
  frameState: FrameLayoutState;
  people: PersonView[];
  /** `cycle` when the plan has no schedule at all, which is what the control says. */
  scheduleError: 'cycle' | null;
  /** Issues the arrangement and says it landed; built where the toast stack is. */
  arrangeBySchedule: () => void;
  chartRead: ChartRead;
  estimateMethod: 'pert' | 'optimistic' | 'realistic' | 'pessimistic';
  commitQuery: (projectId: string, query: string) => void;
  facets: Omit<FilterCriteria, 'query'>;
  setFacets: React.Dispatch<React.SetStateAction<Omit<FilterCriteria, 'query'>>>;
  facetTeams: FacetOption[];
  facetTags: FacetOption[];
  facetServices: FacetOption[];
  facetPeople: FacetOption[];
  facetBands: { id: string; label: string }[];
  facetSteps: { id: string; label: string }[];
  ownershipKnown: boolean;
  membershipKnown: boolean;
  savedViews: SavedView[];
  filterLabels: FilterLabels;
  setSavedViews: React.Dispatch<React.SetStateAction<SavedView[]>>;
  setStoredHiddenColumns: React.Dispatch<React.SetStateAction<readonly string[]>>;
  offeredColumns: { id: string; label: string }[];
  toggleColumn: (columnId: string) => void;
  shownRows: Row<PlanTableFeatures, PlanRenderRow>[];
  search: TreeNarrowing;
  gaps: EstimateGaps;
  walkToNextGap: () => void;
  stack: { undoable: boolean; redoable: boolean };
  stepStack: (direction: 'undo' | 'redo') => Promise<void>;
  setCheatSheetOpen: React.Dispatch<React.SetStateAction<boolean>>;
  exportAvailable: boolean;
  copyAsMarkdown: () => void;
  copyAsMermaid: () => void;
  downloadCsv: () => void;
  downloadMermaidDocument: () => void;
  downloadChartSvg: () => void;
  downloadOnScreen: () => void;
  mermaidSectionMode: 'step' | 'outline' | 'assignee';
  setMermaidSectionMode: React.Dispatch<React.SetStateAction<'step' | 'outline' | 'assignee'>>;
  startDate: string | null;
  chooseEstimateMethod: (method: 'pert' | 'optimistic' | 'realistic' | 'pessimistic') => void;
}) {
  // Selected optimized and still drawn by Fast — solving, failed or infeasible,
  // which are one state to a reader waiting for the schedule they picked. The
  // same three conditions be-01 refuses `schedule_not_ready` on.
  const awaitingSchedule =
    chartRead.optimization !== undefined &&
    chartRead.optimization.enabled &&
    chartRead.optimization.engine === 'optimized' &&
    chartRead.optimization.displayed === 'fast';

  const exportMenu = useClosedByPointerOutside();
  const [query, setQuery] = useState(criteria.query);
  const deferredQuery = useDeferredValue(query);
  useEffect(() => {
    commitQuery(projectId, deferredQuery);
  }, [commitQuery, deferredQuery, projectId]);
  const currentCriteria = { ...criteria, query };

  return (
    <>
      {/*
        Both writes on the numbering, behind one control.

        **A menu and not a toggle**, and that is the whole of `design.md` D4:
        `Freeze numbering` freezes every current number and `Unfreeze all`
        releases every frozen row, but a plan may be **partly** frozen — a row's
        own ⋯ unfreezes one — so an `aria-pressed` button or a label that
        swapped would claim a state this project does not have.

        Both items are always present and both are enabled while the toolbar is
        not busy. `Unfreeze all` on a plan with nothing frozen is a no-op write,
        which is exactly what it was as a button; making it conditional would
        need an "is anything frozen" read the toolbar does not have.

        The trigger carries `disabled={busy}` and the affordance for the reason
        the two buttons did: these are the plan's writes, and a click during a
        refetch is a click be-01 would answer 409 to.
      */}
      <MenuControl
        name="Freeze #"
        data-hint="Freeze the numbering as it stands, or release every frozen row"
        align="left"
        open={freezeMenuOpen}
        onOpen={() => {
          setFreezeMenuOpen(true);
        }}
        onClose={() => {
          setFreezeMenuOpen(false);
        }}
        busy={busy}
        actions={[
          {
            id: 'freeze',
            label: 'Freeze numbering',
            run: () => void run(() => api.freezeProject(projectId)),
          },
          {
            id: 'unfreeze-all',
            label: 'Unfreeze all',
            run: () => void run(() => api.unfreezeProject(projectId)),
          },
        ]}
        trigger={{
          className: buttonVariants({ variant: 'outline', size: 'sm' }),
          disabled: busy,
          ...busyAffordance(busy),
        }}
      >
        Freeze #
      </MenuControl>
      <Button
        size="sm"
        type="button"
        // One of the three controls that aims the caret itself — the new
        // row's name, through `focusIntent` below. See {@link TAKES_THE_FOCUS}.
        {...{ [TAKES_THE_FOCUS]: '' }}
        onClick={addWorkItem}
        // The one write in this toolbar that is **not** `disabled={busy}`, and
        // {@link addWorkItem} is where the argument is: each click is its own
        // row, so refusing one loses work rather than deduplicating a command.
        // The affordance stays — the wait is still shown, it just no longer
        // eats what arrives during it.
        {...busyAffordance(busy)}
      >
        Add work item
      </Button>
      {/*
        The two ends of the expansion, which is otherwise one triangle at a
        time — a forty-row plan takes forty clicks to fold. Both write the
        reader's own expansion, and it is remembered per project from there.

        Disabled while the Find box holds something, for the reason the
        triangles are hidden then: what is open during a search is the
        search's answer, and a button that appeared to do nothing would read
        as broken. Not disabled by `busy`, unlike the control above: neither
        asks be-01 for anything.

        **Icon buttons whose names did not change.** Eighteen characters of a
        width-constrained bar said what a chevron says, so the words moved from
        the face of the button into its `aria-label` — which is where the two
        facts "a smaller thing" and "the same control" are made one, exactly as
        `project-page.tsx`'s `✎` already does. Every existing test and every
        screen-reader path still finds `Expand all` and `Collapse all`, and that
        the old cases pass **unchanged** is the proof the names held.

        The chevron pair points apart to open and together to close, which is
        deliberately **not** the `▾`/`▸` a row's own disclosure control uses:
        one shape with a per-row meaning and a per-plan meaning is a shape a
        reader disambiguates by position. See `toolbar-icons.tsx`.
      */}
      <Button
        variant="outline"
        size="square"
        type="button"
        disabled={filtering}
        aria-label="Collapse all"
        // The refusal is about the filter the reader has on right now, so it
        // does not wait; what the button does when it is live is the tool.
        {...(filtering
          ? { 'data-fact': 'Clear the filter first — a filter opens whatever it has to.' }
          : { 'data-hint': 'Close every branch' })}
        onClick={() => {
          setExpanded({});
        }}
      >
        <CollapseIcon />
      </Button>
      <Button
        variant="outline"
        size="square"
        type="button"
        disabled={filtering}
        aria-label="Expand all"
        {...(filtering
          ? { 'data-fact': 'Clear the filter first — a filter opens whatever it has to.' }
          : { 'data-hint': 'Open every branch' })}
        onClick={() => {
          setExpanded(true);
        }}
      >
        <ExpandIcon />
      </Button>
      {/*
        Whether the project picked the optimized engine and is still being drawn
        by Fast — solving, failed or infeasible, which are one state to a reader
        waiting for their own schedule. The same three conditions be-01 refuses
        `schedule_not_ready` on, read off the payload the chart is already
        holding rather than asked for again.
      */}
      {/*
        One press puts every sibling group in the order its bars start — the
        third control that acts on the tree's shape, after the two that open and
        close it.

        **An icon, and its name is the thing that does not change** (D1 of
        `plan-toolbar-controls`): `Arrange by schedule` is what every test and
        every screen reader finds, and the staircase is what the bar spends
        width on. Dany asked for "an icon" and "a small column for now" on
        2026-09-10, which is the narrowest control this bar can carry.

        **Two states swap the hint for a fact and disable it**, because in both
        of them be-01 would refuse and the reason is about *this plan* rather
        than about the tool. A cycle has no schedule to arrange by; a project on
        the optimized engine that is still drawing Fast has not got the one it
        picked yet, and arranging by Fast there would leave the rows in an order
        the reader did not choose with nothing on screen admitting it (ADR
        0023).
      */}
      <Button
        variant="outline"
        size="square"
        type="button"
        disabled={busy || scheduleError === 'cycle' || awaitingSchedule}
        aria-label="Arrange by schedule"
        {...(scheduleError === 'cycle'
          ? {
              'data-fact':
                'The plan has a dependency cycle, so there is no schedule to arrange by.',
            }
          : awaitingSchedule
            ? { 'data-fact': 'Optimizing… arrange once the schedule settles.' }
            : { 'data-hint': 'Put every sibling in the order its bar starts' })}
        {...busyAffordance(busy)}
        onClick={arrangeBySchedule}
      >
        <ArrangeIcon />
      </Button>
      {/*
        The schedule as something to look at, under the plan. `aria-pressed`
        rather than two labels: it is one thing that is on or off, and a button
        whose word changes is a button that reads as "Gantt" when the chart is
        already there.

        Not disabled by `busy` and not by a cycle: it asks be-01 for nothing,
        and the panel is where the unscheduled state is said out loud.
      */}
      <Button
        variant="outline"
        size="sm"
        type="button"
        aria-pressed={ganttOpen}
        data-hint="Draw the schedule under the plan"
        onClick={() => {
          setGanttOpen((open) => !open);
        }}
      >
        Gantt
      </Button>
      {/*
        Everything the **project** configures about itself — its teams' capacity,
        its priority ladder, and its steps — behind one control, since
        `project-config-modal` (2026-08-30). These were three labelled buttons
        here, each a thing somebody sets once and then leaves for weeks, sitting
        permanently beside `Add work item` and `Undo` on a bar whose width is the
        scarce resource. The three surfaces are three sections of one modal now.

        The button belongs to the modal rather than sitting beside it: Radix
        restores the focus to its **trigger** on close and to nothing at all
        without one, so the two are one component. The surface itself lands in
        a portal, not here. A gear on this bar and its name on the phone's
        sheet, which lists its controls by word and has the room.

        Not disabled by `busy`: each section has its own in-flight state, and a
        button that went dead while somebody else's edit was refetching would
        be unopenable on a plan two people are working on.

        The teams section reads every row's **effective** teams, so a team only
        an ancestor carries is offered a box: its pool is what the leaves below
        it spend. The same reading the cell, the cards, the export and the bars
        use — one `effectiveTeamsOf` per render and never a second copy.
        Flattened, because a row on two teams puts a box beside each of them.
        C3 put that box in the directory, where a global size belonged; the
        number is one plan's now (`capacity-per-project`, Dany 2026-08-13), and
        the directory page has no plan.

        The steps section is handed the same `frameState` the `<colgroup>`
        above is resolved from, so the figure it quotes and the width the table
        lays out cannot be answers to two different questions.
      */}
      <ProjectSettingsModal
        projectId={projectId}
        trigger={renderer === 'cards' ? 'labelled' : 'glyph'}
        teams={{
          teams: teamsOnThePlan(
            teams,
            teamCapacities,
            flat.flatMap((row) => effectiveTeams.get(row.id)?.teamIds ?? []),
          ),
          setCapacity: (teamId, size) => api.setTeamCapacity(projectId, teamId, size),
          onChanged: refreshOrMarkStale,
        }}
        priorities={{
          bands: priorityBands,
          setBands: (bands) => api.setPriorityBands(projectId, bands),
          onChanged: refreshOrMarkStale,
        }}
        steps={{
          steps,
          hiddenColumnIds,
          frameState,
          numberOf: (workItemId) => flat.find((row) => row.id === workItemId)?.number ?? null,
          nameOf: (personId) => people.find((person) => person.id === personId)?.name ?? null,
          addStep: (name) => api.addStep(projectId, name),
          renameStep: (stepId, name) => api.renameStep(projectId, stepId, name),
          removeStep: (stepId, cascade) => api.removeStep(projectId, stepId, cascade),
          // How far a dependency reaches, on the same surface as the steps it
          // is about: reordering them moves what an `anchor-slice` dependency
          // waits for. Off the chart read rather than a state of its own, so
          // the value ticked here and the reach the arrows were drawn with are
          // one fact.
          depReach: chartRead.depReach,
          setDepReach: (reach: DependencyReach) => api.setDepReach(projectId, reach),
          // The same reread every other change on this page makes, which is
          // what puts the new columns on the table and the new list in the
          // section.
          onChanged: refreshOrMarkStale,
        }}
        estimating={{
          // The method is reported, not set: `Plan with` on the bar is the one
          // control for it, and a second would be two answers to one question.
          method: estimateMethod,
          // Off the chart read, like the reach above and for the same reason —
          // these are the weights the figures on screen were computed with.
          pertWeights: chartRead.pertWeights,
          estimateRounding: chartRead.estimateRounding,
          setArithmetic: (arithmetic) => api.setEstimateArithmetic(projectId, arithmetic),
          onChanged: refreshOrMarkStale,
        }}
        {...(chartRead.optimization === undefined
          ? {}
          : {
              optimization: {
                value: chartRead.optimization,
                setSettings: (patch) => api.setOptimizationSettings(projectId, patch),
                onChanged: refreshOrMarkStale,
              },
            })}
      />
      {/*
        Find. Deliberately without `data-cell`: this is not a cell of the
        table's keyboard grid, and letting Tab and the arrows walk into it
        from the last cell of a row would put the caret somewhere no edit can
        be made.
      */}
      <Input
        className="h-8 w-32 text-xs"
        aria-label="Find"
        placeholder="Find…"
        size={14}
        data-hint="Show work items whose name contains this, with the rows above and below them"
        value={query}
        onChange={(e) => {
          setQuery(e.currentTarget.value);
        }}
        onKeyDown={(e) => {
          // Escape empties the box, which is how a search is left — and
          // leaving it puts every collapsed branch back, because the search
          // never wrote to the reader's own expansion.
          if (e.key !== 'Escape') return;
          e.preventDefault();
          setQuery('');
        }}
      />
      {/*
        The other six of R10's seven fields. Beside the Find box because they
        are the same act — narrowing the plan — and the count below counts what
        all seven left, not what each one did.
      */}
      <FilterFacets
        facets={facets}
        setFacets={setFacets}
        teams={facetTeams}
        tags={facetTags}
        services={facetServices}
        people={facetPeople}
        bands={facetBands}
        steps={facetSteps}
        // The two directory maps read as one bit each — the same two the row
        // facets are computed from, so the box and the answer behind it can
        // never disagree about whether the question is askable.
        ownershipKnown={ownershipKnown}
        membershipKnown={membershipKnown}
      />
      {/*
        Name the current filter, or pick one already named — R10 F4. Beside
        `FilterFacets` because saving and ticking are the same act's two
        moments, and applying a view writes {@link query} and {@link facets}
        exactly as typing and ticking would.
      */}
      <SavedViews
        views={savedViews}
        current={currentCriteria}
        labels={filterLabels}
        onSave={(name) => {
          const next = [
            ...savedViews,
            { id: crypto.randomUUID(), name, criteria: currentCriteria, hiddenColumnIds },
          ];
          setSavedViews(next);
          rememberSavedViews(projectId, next);
        }}
        onApply={(view) => {
          const { query: savedQuery, ...savedFacets } = view.criteria;
          setQuery(savedQuery);
          setFacets(savedFacets);
          // A view with no column set leaves the columns as they are — see
          // {@link SavedView}. One with a set applies it and remembers it, as
          // the Columns control would have.
          if (view.hiddenColumnIds !== undefined) {
            setStoredHiddenColumns(view.hiddenColumnIds);
            rememberHiddenColumns(projectId, view.hiddenColumnIds);
          }
        }}
        onDelete={(id) => {
          const next = savedViews.filter((view) => view.id !== id);
          setSavedViews(next);
          rememberSavedViews(projectId, next);
        }}
      />
      <ColumnsControl
        offered={offeredColumns}
        hiddenColumnIds={hiddenColumnIds}
        onToggle={toggleColumn}
      />
      {filtering && (
        <span role="status" className="text-muted-foreground text-sm">
          {shownRows.length} of {flat.length} rows
        </span>
      )}
      {/*
        Said out loud rather than left to an empty table, which reads as a
        plan that has been lost rather than a filter that found nothing. The
        count beside it stays, so `0 of 12 rows` says the twelve are still
        there.

        Two sentences, because a filter with nothing typed into it has no
        query to quote: `No matches for “”` would be a question mark where the
        reason should be.
      */}
      {filtering && search.matchIds.size === 0 && (
        <span className="text-sm">
          {criteria.query.trim() === ''
            ? 'No rows match these filters'
            : `No matches for “${criteria.query}”${
                facetsChosen(facets) > 0 ? ' with these filters' : ''
              }`}
        </span>
      )}
      {/*
        How ready this plan is to be read, and the way to the rows that make
        it not ready. Absent entirely when every leaf is estimated for every
        step: a complete plan needs no badge, and a tick that is always there
        is a thing to stop seeing — this has to be noticed the day it appears.

        Not disabled while the table is busy, unlike the buttons beside it:
        it writes nothing, and a button that greys out during somebody else's
        refetch reads as broken.
      */}
      {gaps.leaves.length > 0 && (
        <Button
          variant="outline"
          size="sm"
          type="button"
          // The second control that aims the caret itself: `walkToNextGap`
          // puts it in the cell that estimates the next gap. See
          // {@link TAKES_THE_FOCUS}.
          {...{ [TAKES_THE_FOCUS]: '' }}
          data-fact={describeGaps(gaps)}
          onClick={walkToNextGap}
        >
          {gaps.leaves.length} unestimated
        </Button>
      )}
      {/*
        The way in for anyone who never learns the chord — which is most
        people, and the reason the buttons are here at all rather than the
        keyboard being the only route. Disabled by `busy` like every other
        control that writes, and by an empty half of the stack: be-01 would
        answer 409 and a button that is always live invites that.

        The disabled state is read off the last tree read rather than counted
        here. It is per account, and be-01 is the only thing that knows what
        somebody else's edit did to it.
      */}
      <Button
        variant="outline"
        size="sm"
        type="button"
        disabled={busy || !stack.undoable}
        {...busyAffordance(busy)}
        aria-label="Undo"
        data-hint="Undo your last change to this plan (Ctrl/⌘ + Z)"
        onClick={() => {
          void stepStack('undo');
        }}
      >
        ↶
      </Button>
      <Button
        variant="outline"
        size="sm"
        type="button"
        disabled={busy || !stack.redoable}
        {...busyAffordance(busy)}
        aria-label="Redo"
        data-hint="Put back what you last undid (Ctrl/⌘ + Shift + Z)"
        onClick={() => {
          void stepStack('redo');
        }}
      >
        ↷
      </Button>
      {/*
        The way in for anyone who was never told about `?`, which is most
        people the first time. Not disabled by `busy`: it asks be-01 for
        nothing and reads nothing that a refetch could change.
      */}
      <Button
        variant="outline"
        size="sm"
        type="button"
        aria-label="Keyboard shortcuts"
        data-hint="Keyboard shortcuts (?)"
        // The third control that aims the caret itself: the cheat sheet takes
        // the focus onto its own panel as it mounts, and Radix's restore
        // arrives after it. See {@link TAKES_THE_FOCUS}.
        {...{ [TAKES_THE_FOCUS]: '' }}
        onClick={() => {
          setCheatSheetOpen(true);
        }}
      >
        {/*
          Drawn, not named. This was `⌨` (U+2328) until 2026-08-29, and macOS
          has no colour presentation for it: the system font falls back to a
          hairline outline that is illegible at button size, and what the
          control meant was carried entirely by a codepoint the app does not
          control the rendering of.
        */}
        <KeyboardIcon />
      </Button>
      {/*
        Sharing the plan, which is what most of it is written for. All four
        take the whole plan rather than what is on screen, and none asks
        be-01 for anything — so none is disabled by `busy`, and all four
        work while the socket is down or the tree is stale. What they cannot
        do is say the figures are current; the header's timestamp is what
        says when they were true. The two Mermaid buttons add a fourth
        clipboard/download outcome the CSV and Markdown-table pair do not
        have: a plan a gantt cannot be drawn of at all (no start date, no
        schedule, or nothing placed), reported the same way a refused
        clipboard write already is. The chart's `.svg` adds a fifth: there is
        no drawing on screen to take a copy of, which is a fact about this
        page rather than about the plan — see {@link downloadChartSvg}.
      */}
      {/*
        One menu for the six, since `configurable-columns`: measured at 1280,
        the five buttons of that day took 683px of a 1248px toolbar and a thirteenth
        control pushed the row to three lines. A `<details>`, as Filters and
        Views are — no dismiss handler, and a `<button>` inside it still
        closes the phone's sheet (`closingControlIn`). The buttons keep their
        names, titles and handlers; the only thing that moved is where they
        sit.
      */}
      {/* Proof: removing `exportAvailable` left `<details data-export>` in the
          unavailable-plan fixture; expected null, received the live Export menu. */}
      {exportAvailable && (
        <details ref={exportMenu} data-export className="relative">
          <summary
            className="border-input h-8 cursor-pointer rounded-md border px-2 py-1 text-xs select-none"
            data-hint="Copy or download the plan — as a Markdown table, a Mermaid gantt, a CSV, or what is on screen"
          >
            Export
          </summary>
          <div
            data-export-panel
            className="bg-popover absolute z-50 mt-1 flex w-56 flex-col items-stretch gap-1 rounded-md border p-2 shadow-md"
          >
            <Button
              variant="outline"
              size="sm"
              type="button"
              data-hint="Copy the whole plan as a Markdown table, with a header saying how to read it"
              onClick={copyAsMarkdown}
            >
              Copy as Markdown
            </Button>
            <Button
              variant="outline"
              size="sm"
              type="button"
              data-hint="Copy the chart as a Mermaid gantt, for a Markdown document that draws it"
              onClick={copyAsMermaid}
            >
              Copy as Mermaid
            </Button>
            <Button
              variant="outline"
              size="sm"
              type="button"
              data-hint="Download the whole plan as a CSV, with a header saying how to read it"
              onClick={downloadCsv}
            >
              Download CSV
            </Button>
            <Button
              variant="outline"
              size="sm"
              type="button"
              data-hint="Download the chart as a Mermaid gantt bundled with the Markdown table, with a header saying how to read it"
              onClick={downloadMermaidDocument}
            >
              Download as Markdown
            </Button>
            {/*
            The chart as a picture, in the menu every other export is in. It
            was on the chart's own control strip alone until 2026-08-31 — a
            `⇩` glyph beside `Full` — which is where somebody already
            looking at the chart finds it and nowhere a reader asking "how do I
            send this to somebody" looks. Both stand now: the glyph where the
            chart is, this where the exports are.

            Not disabled while the chart is closed. A control that is there and
            says why is a control that teaches where the chart is; a greyed one
            says nothing at all, and the five beside it are never disabled
            either.
          */}
            <Button
              variant="outline"
              size="sm"
              type="button"
              data-export-chart-svg
              data-hint="Download the chart as a standalone .svg — every bar, arrow, hand-off and colour, openable with no app around it"
              onClick={downloadChartSvg}
            >
              Download chart as SVG
            </Button>
            {/*
            The one action that takes the rows on screen rather than the plan. Its
            own button rather than a switch on the four beside it: a mode on a
            button whose header claims the whole plan is how a partial plan gets
            sent as a whole one, which is what §9's Q3 refused. Always offered, not
            only while a filter is on — a collapsed branch narrows the screen too,
            and the `Scope` line it writes says which of the two did it.
          */}
            <Button
              variant="outline"
              size="sm"
              type="button"
              data-hint="Download the rows on screen as a Markdown table, with a header saying what was filtered out and what is missing"
              onClick={downloadOnScreen}
            >
              Download what’s on screen
            </Button>
            {/*
            The one setting among the six actions, and it governs two of them:
            `Copy as Mermaid` and `Download as Markdown` both write their fence
            through it. Mermaid has exactly one grouping channel and it is
            `section`, so a fence can be lanes of outline, of step, or of
            person, and never of two at once — which is why this is a picker
            rather than three buttons or three tick boxes.

            Inside the Export menu rather than on the bar, and that is a
            measurement rather than a taste: the panel is `absolute`, so the
            `<details>` the toolbar lays out is its summary and nothing else,
            and a control in here costs the folded toolbar's budget (`e2e/
            layout.spec.ts`, 1600px at 1280) exactly nothing. It also sits
            where the two exports it is about already are.

            A `<select>` rather than a `<Button>`: {@link closingControlIn}
            closes the phone's sheet on a `<button>` inside it, and a picker
            that dismissed the sheet before the export it configures could be
            reached would be a setting nobody can spend.
          */}
            <label className="mt-1 flex items-center justify-between gap-1 text-xs">
              Mermaid lanes
              <select
                className="border-input bg-background h-8 rounded-md border px-2 text-xs"
                // No `aria-label`: the `<label>` wrapping it already names it,
                // which is where it parts from `Final estimate` below — that one
                // reads `Plan with` on screen and needs the name spelling out.
                data-hint="What the two Mermaid exports group their bars into — the plan's outline, the step a bar is estimated under, or whoever is on it"
                value={mermaidSectionMode}
                onChange={(e) => {
                  const asked = e.target.value;
                  // Narrowing, **not** a guard, and no negative test is owed for
                  // it: `value` is typed `string` and the options are
                  // {@link SECTION_MODES} itself, so nothing a browser can put
                  // here fails it. The same line the `Plan with` picker below
                  // carries, for the same reason. The real boundary is
                  // {@link rememberedMermaidSectionMode}, which reads storage.
                  if (!isSectionMode(asked)) return;
                  // Stored where it is picked and nowhere else, exactly as the
                  // chart's own rung is: opening a plan must not write to it.
                  setMermaidSectionMode(asked);
                  rememberMermaidSectionMode(asked);
                }}
              >
                {SECTION_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </details>
      )}
      <label className="ml-auto flex items-center gap-1 text-sm">
        Starts
        {/*
          The day the whole plan begins. Setting it moves every date at once,
          because every date is an offset from it — there is nothing stored
          per row to drag along.
        */}
        <DateField
          className="border-input bg-background h-8 rounded-md border px-2 text-sm"
          aria-label="Project start date"
          disabled={busy}
          {...busyAffordance(busy)}
          value={startDate ?? ''}
          commit={(typed) => {
            void run(() => api.setStartDate(projectId, typed === '' ? null : typed));
          }}
        />
      </label>
      <label className="flex items-center gap-1 text-sm">
        Plan with
        {/*
          A project-wide setting rather than a per-reader preference: the
          dates below are computed from it, and two people reading different
          dates off one plan is the failure this must not have.
        */}
        <select
          className="border-input bg-background h-8 rounded-md border px-2 text-sm"
          aria-label="Final estimate"
          value={estimateMethod}
          disabled={busy}
          {...busyAffordance(busy)}
          onChange={(e) => {
            const chosen = e.target.value;
            if (isEstimateMethod(chosen)) chooseEstimateMethod(chosen);
          }}
        >
          <option value="pert">PERT</option>
          <option value="optimistic">optimistic</option>
          <option value="realistic">realistic</option>
          <option value="pessimistic">pessimistic</option>
        </select>
      </label>
      {/*
        No slot here for plan-level controls the table does not own, and that
        is a measurement rather than an omission. The saved-plan shelf held one
        between `adb58ad9` and this change; `project-settings.spec.ts:77` puts
        `[data-toolbar]`'s children against a 1265px budget with a named margin
        for exactly one more control, and a fifth disclosure spent it — the row
        gained a line, and `gantt.spec.ts:2605` could no longer watch the wrap
        it is about, because the bar was already wrapped before the drag. The
        shelf is in the app header's project row now; `SavedPlanShelf` in
        `project-page.tsx` carries the full list of shapes and what each cost.
      */}
    </>
  );
}

/**
 * What a control that is unavailable **because a save is in flight** looks
 * like, as opposed to one that is unavailable because there is nothing for it
 * to do.
 *
 * **The fault it exists for.** Every toolbar control that writes is
 * `disabled={busy}` for the whole of the write *and* the refetch after it, and
 * a `disabled` button drops a click on the floor without a sound. Typing a
 * character, pressing ⌘+Enter and clicking `Add work item` in the same breath
 * produced a `PATCH` and two `GET`s and **no `POST` at all** — no new row, no
 * cursor change, no message. Reproduced on demand in Chrome, 2026-08-09.
 *
 * The click is still dropped: queuing it would be a second, invisible order of
 * operations over a plan two people are editing, and that is a design decision
 * nobody has made. What this changes is that the drop is **visible** — the
 * whole toolbar says `aria-busy`, and the controls the wait is holding back
 * fade and take the progress cursor, so a click that goes nowhere lands on
 * something that already said it would.
 *
 * `Undo` with nothing to undo gets none of this and that is the distinction
 * being drawn: it is disabled because the stack is empty, waiting will not
 * change it, and a progress cursor over it would be a lie. The affordance is
 * spread only while `busy` is true, so a control disabled for both reasons
 * wears it for exactly as long as the wait is the reason.
 */
export const busyAffordance = (busy: boolean): { 'data-busy'?: ''; style?: CSSProperties } =>
  busy ? { 'data-busy': '', style: { cursor: 'progress', opacity: 0.6 } } : {};
