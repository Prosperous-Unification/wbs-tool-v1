import type { EffectiveServices } from '@wbs/domain/effective-service';
import type { EffectiveTags } from '@wbs/domain/effective-tag';
import type { EffectiveTeams } from '@wbs/domain/effective-team';
import { priorityBandOf } from '@wbs/domain/priority-band';
import { useEffect, useMemo, useRef, useState } from 'react';

import type {
  PriorityBandView,
  ServiceView,
  TagView,
  TeamView,
  WorkItemTypeView,
} from '@/lib/wbs-api';
import { type StepView } from '@/lib/wbs-api';

import { findEstimateGaps } from './plan-completeness';
import { assigneesOf } from './plan-mismatch';
import type { SavedView } from './remembered-layout';
import { rememberedSavedViews } from './remembered-layout';
import {
  type FacetCriteria,
  type FilterCriteria,
  type FilterLabels,
  isFiltering,
  type NarrowableRow,
  narrowTree,
  NO_FACETS,
} from './tree-search';
import type { ChartRead } from './use-plan-read';
import { type TreeRow } from './wbs-rows';

/** One tickable value of one facet: what to filter by, and what to call it. */
export interface FacetOption {
  id: string;
  label: string;
}

/** How many facet values are ticked, which is what the control says on itself. */
export function facetsChosen(facets: FacetCriteria): number {
  return (
    facets.teamIds.length +
    facets.tagIds.length +
    facets.serviceIds.length +
    (facets.builtByNonOwner ? 1 : 0) +
    (facets.assignedOutsideTeam ? 1 : 0) +
    facets.assigneeIds.length +
    facets.priorityBands.length +
    facets.estimatedStepIds.length +
    (facets.unestimated ? 1 : 0) +
    (facets.critical ? 1 : 0)
  );
}

/** A value ticked or unticked, as a new list — the state here is never mutated in place. */
export const toggledIn = (chosen: readonly string[], id: string): string[] =>
  chosen.includes(id) ? chosen.filter((each) => each !== id) : [...chosen, id];

/**
 * What one facet offers, for the two facets whose values have no order of their
 * own: the teams and the people on this plan.
 *
 * **The plan's values, plus whatever is still ticked.** `present` is what the
 * rows on screen actually carry, so a facet never offers a value whose only
 * possible answer is an empty table. But the tree refetches on everybody's
 * edit, so the row a tick was aimed at can leave while the tick is still in
 * force — and dropping the box then would narrow the plan to nothing with
 * nothing on screen to untick. So a ticked value is offered whether the plan
 * still carries it or not.
 *
 * By label, because neither teams nor people have a meaning in the order be-01
 * happens to return them in — unlike the bands, which are a ladder, and the
 * steps, which are the order of the columns they estimate. Those two keep
 * their own order and do not come through here.
 */
export function optionsFor(
  present: ReadonlySet<string>,
  picked: readonly string[],
  labelOf: (id: string) => string,
): FacetOption[] {
  return [...new Set([...present, ...picked])]
    .map((id) => ({ id, label: labelOf(id) }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

/**
 * What a reader has typed and ticked: the Find box, the facets, and the views
 * they have saved.
 *
 * State only. The narrowing it produces is derived on every render by
 * {@link usePlanFilter}, so nothing here can be stale against the rows.
 */
export function usePlanFilterState({ projectId }: { projectId: string }) {
  /**
   * What has been typed into the Find box.
   *
   * The narrowing itself is not state: it is {@link narrowTree} of the rows on
   * screen and this string, re-derived every render. A remembered answer would
   * narrow to a plan that no longer exists — every edit by anybody refetches
   * the whole tree.
   */
  const [query, setQuery] = useState('');

  /**
   * Which facets are ticked beside the Find box — the other six of R10's seven
   * fields.
   *
   * `useState` and nothing else, deliberately: **an ad-hoc filter is not
   * remembered across a reload** (R10 §9's Q6, Dany 2026-08-17). The plan you
   * open is the whole plan; a filter restored from a session you do not
   * remember setting is the "my rows are gone" report, and it is the single
   * most likely support question this change could create. Named, deliberate
   * criteria you come back to are saved views — F4, and the opposite gesture.
   *
   * Not the URL either: which project is open lives in localStorage
   * (`project-page.tsx`) and `/` names none of it, so there is nothing here a
   * link could carry to somebody else yet.
   */
  const [facets, setFacets] = useState<Omit<FilterCriteria, 'query'>>(NO_FACETS);

  /**
   * The filters this browser has named and saved for this project — F4, and
   * the deliberate opposite of {@link facets} beside it: this **is**
   * remembered across a reload, because naming one and picking it back up is
   * a deliberate act and not a restored session nobody asked for.
   *
   * Read straight into the initial state for {@link rememberedExpansion}'s
   * reason: an effect would open the panel with nothing in it for one frame.
   */
  const [savedViews, setSavedViews] = useState<SavedView[]>(() => rememberedSavedViews(projectId));

  /** Which project the saved views above belong to, so a save cannot pair it with another. */
  const savedViewsProject = useRef(projectId);

  /**
   * Swaps the saved views whole when the project does.
   *
   * Nothing is written here, for {@link widthProject}'s effect's reason: Save
   * and Delete are the only writers, so there is no first-save-after-a-switch
   * to guard against — only the read, which would otherwise offer one
   * project's views on another's plan.
   */
  useEffect(() => {
    if (savedViewsProject.current === projectId) return;
    savedViewsProject.current = projectId;
    setSavedViews(rememberedSavedViews(projectId));
  }, [projectId]);
  return { query, setQuery, facets, setFacets, savedViews, setSavedViews };
}

/**
 * The rows this render shows, and the six facet lists the panel offers.
 *
 * Derived rather than stored, every render: a filter held as state alongside
 * the rows is a filter that can describe a plan the reader is no longer
 * looking at.
 */
export function usePlanFilter({
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
}: {
  flat: TreeRow[];
  steps: StepView[];
  effectiveTeams: Map<string, EffectiveTeams>;
  effectiveServices: Map<string, EffectiveServices>;
  mismatchByRow: Map<string, { unownedServices: string[]; outsideAssignees: string[] }>;
  effectiveTags: Map<string, EffectiveTags>;
  priorityBands: PriorityBandView[];
  query: string;
  facets: Omit<FilterCriteria, 'query'>;
  teams: TeamView[];
  chartRead: ChartRead;
  tags: TagView[];
  workItemTypes: WorkItemTypeView[];
  services: ServiceView[];
}) {
  /**
   * What this plan is still short of, per leaf and per step.
   *
   * Recomputed from the tree on screen rather than tracked, for the reason
   * nothing here is patched locally: an estimate can arrive from anybody, and
   * a count kept alongside would be the second answer to a question that has
   * one.
   */
  const gaps = useMemo(() => findEstimateGaps(flat, steps), [flat, steps]);

  /**
   * The rows the readiness badge counts, as a set the filter can ask.
   *
   * The badge's own answer and not a second one: "unestimated" on a checkbox
   * and `12 unestimated` on the button beside it are the same claim, and two
   * readings of it would be two plans.
   */
  const unestimatedIds = useMemo(() => new Set(gaps.leaves.map((leaf) => leaf.rowId)), [gaps]);

  /**
   * Everything the filter is allowed to ask about, one entry per row.
   *
   * Built here rather than inside {@link narrowTree} because every one of the
   * seven facts is already in scope on this component and none of them is the
   * tree walker's business: the walker's job is ancestors, descendants and
   * termination, and a walker that also knew what a priority band was would be
   * two things.
   *
   * **The effective team and not `row.teamIds`** — see {@link RowFacets}. The
   * unestimated set is the readiness badge's own `gaps`, so the facet and the
   * badge beside it cannot report two different plans.
   */
  const narrowable = useMemo<NarrowableRow[]>(
    () =>
      flat.map((row) => {
        // Named once and read below, because both mismatch signals ask about
        // the same two sets the facets themselves carry. Recomputing them per
        // signal is how a filter and the marker beside it start to answer two
        // different questions about one row.
        const teamIds = effectiveTeams.get(row.id)?.teamIds ?? [];
        const serviceIds = effectiveServices.get(row.id)?.serviceIds ?? [];
        const assigneeIds = assigneesOf(row);
        // The **same** answer the two markers wear, not a second call — see
        // {@link mismatchByRow}. A row absent from that map is a row `flat` does
        // not hold, which cannot happen here because both memos walk `flat`.
        const mismatch = mismatchByRow.get(row.id);
        return {
          id: row.id,
          name: row.name,
          parentId: row.parentId,
          facets: {
            teamIds,
            // The **effective** tags, for the effective team's reason one line
            // up: a leaf under a `regulatory` parent is regulatory, and a filter
            // reading stored labels would not find it. Since ADR 0008 that holds
            // even where the leaf states tags of its own — the union, not the
            // nearer statement, which is exactly the case the override rule used
            // to lose.
            tagIds: (effectiveTags.get(row.id) ?? []).map((each) => each.tagId),
            // The row's **own** set, and no `effectiveTypes` map beside the two
            // above because there is no such walk: a type does not inherit
            // (`docs/adr/0009-a-work-item-type-does-not-inherit-at-all.md`), so
            // the stored set is already the effective reading.
            //
            // Three facets, three inheritance rules, on purpose: the team is the
            // nearest statement, the tag is every statement above it, and the
            // type is this row's alone. Each is the rule its own question takes.
            typeIds: row.typeIds,
            // The **effective** service, for the same reason a third time, and
            // `?? null` because absence from the map is how this walk spells
            // "nobody above this row states one".
            //
            // **Task 6.2's watched red, and it is watched here now.** Written as
            // `row.serviceId` — the row's own stored column, `row.serviceIds`
            // since task 10.2 took the column out of the read path — three cases go red
            // (chunk 9, h2puni): `keeps the rows that inherit a ticked service`
            // drops from the whole branch to `['010']`, and both signal cases
            // follow it down, because a service nobody inherits is a service no
            // team can be caught not owning. Chunk 8 could not observe this and
            // said so; what changed is 6.3's facet control, which is the surface
            // that drives the read.
            serviceIds,
            // The two signals, read off {@link mismatchByRow} — which is their
            // **real site**, the one place in the app that answers them per
            // row, and what makes task 6.2's stored-instead-of-effective fault
            // a production fault rather than a fault in a test's own
            // composition (chunk 7's record of 5.2).
            // `libs/domain/src/label-mismatch.ts` owns both rules; that memo
            // hands them the effective reading and the directory's two maps,
            // and neither it nor this holds a rule of its own.
            //
            // `length > 0` over the offenders and not a second row-level call:
            // "some service is unowned" and "the list of unowned services is
            // not empty" are one sentence, and asking the domain twice is how
            // the mark and the facet would come to disagree.
            builtByNonOwner: (mismatch?.unownedServices.length ?? 0) > 0,
            assignedOutsideTeam: (mismatch?.outsideAssignees.length ?? 0) > 0,
            assigneeIds,
            // Null and not a band: a row nobody has prioritised carries no rung,
            // and `priorityBandOf` is asked about numbers only.
            priorityBand:
              row.priority === null
                ? null
                : (priorityBandOf(priorityBands, row.priority)?.label ?? null),
            // `Object.hasOwn` and not a truthy test, which is `findEstimateGaps`'
            // own rule: a stored `0 / 0 / 0` is somebody saying this costs
            // nothing, which is an answer and not an absence.
            estimatedStepIds: steps
              .filter((step) => Object.hasOwn(row.estimates, step.id))
              .map((step) => step.id),
            unestimated: unestimatedIds.has(row.id),
            // be-01's own answer for the row, not a second reading of the
            // slices: a row is on the critical path when its work is, and the
            // Slack cell and the card both already print this field.
            critical: row.schedule.critical,
          },
        };
      }),
    [
      flat,
      effectiveTeams,
      effectiveTags,
      effectiveServices,
      // The two booleans above are read out of this map and not recomputed
      // here, and it is how the directory reaches this list: the three
      // readings above all derive from `flat`, but service ownership and team
      // membership come from the directory read, which reloads on its own, and
      // `mismatchByRow` is rebuilt from both. A team given a service in the
      // directory therefore re-answers every marker on screen instead of
      // leaving it at the map as it was at the last tree fetch.
      mismatchByRow,
      priorityBands,
      steps,
      unestimatedIds,
    ],
  );

  /**
   * What the filter is asking for: which rows stay, which of them are hits,
   * and what has to be open to show them.
   *
   * A pure function of the rows on screen and the criteria, memoised only so
   * the table's own row model is not rebuilt on every unrelated render — never
   * cached across a change to either. A structural edit refetches the tree and
   * this narrows the tree that came back, which is why a row moved out of the
   * match set disappears from the narrowed view.
   */
  const criteria = useMemo<FilterCriteria>(() => ({ query, ...facets }), [query, facets]);

  const search = useMemo(() => narrowTree(narrowable, criteria), [narrowable, criteria]);

  /**
   * Whether a filter is on — a query with something in it other than spaces,
   * or any facet ticked, and exactly when {@link narrowTree} hands back an
   * overlay.
   *
   * One source of truth rather than a second trim beside it, which is how two
   * answers to one question start to disagree. Read through {@link isFiltering}
   * rather than off the overlay so the controls that stand down while a filter
   * is on do not have to hold a narrowed tree to ask.
   */
  const filtering = isFiltering(criteria);

  /**
   * The names the ids inside a {@link FilterCriteria} stand for, in this
   * plan's own words — one object read by the filtered export's `Scope` line
   * ({@link planOnScreen}) and by the saved-views panel's tooltip, so a
   * filter is never described two different ways.
   */
  const filterLabels: FilterLabels = {
    teamName: (teamId) =>
      teams.find((team) => team.id === teamId)?.name ?? 'a team this plan has not loaded',
    personName: (personId) =>
      chartRead.people.find((person) => person.id === personId)?.name ??
      'somebody this plan has not loaded',
    stepName: (stepId) => steps.find((step) => step.id === stepId)?.name ?? '(unknown)',
    tagName: (tagId) =>
      tags.find((each) => each.id === tagId)?.name ?? 'a tag this plan has not loaded',
    typeName: (typeId) =>
      workItemTypes.find((each) => each.id === typeId)?.name ?? 'a type this plan has not loaded',
    // Names a service since task 6.3 pulled `listServices` forward out of 7.6.
    // The fallback is the one every lookup here keeps: a saved view can hold an
    // id whose service the directory has since removed, and printing the id
    // would put a uuid in the export's `Scope` line.
    serviceName: (serviceId) =>
      services.find((each) => each.id === serviceId)?.name ?? 'a service this plan has not loaded',
  };

  const facetTeams = useMemo(
    () =>
      optionsFor(
        new Set(narrowable.flatMap((row) => row.facets.teamIds)),
        facets.teamIds,
        (id) =>
          // The Team cell's own sentence for a label the directory read has
          // not caught up with, rather than a blank box.
          teams.find((team) => team.id === id)?.name ?? 'a team this plan has not loaded',
      ),
    [narrowable, facets.teamIds, teams],
  );

  /**
   * The tags any row on this plan carries, plus whatever is already ticked.
   *
   * The plan's own vocabulary rather than the whole directory, for
   * `facetTeams`' reason: a facet offering a value no row has is a filter whose
   * only possible answer is an empty table.
   */
  const facetTags = useMemo(
    () =>
      optionsFor(
        new Set(narrowable.flatMap((row) => row.facets.tagIds)),
        facets.tagIds,
        (id) => tags.find((each) => each.id === id)?.name ?? 'a tag this plan has not loaded',
      ),
    [narrowable, facets.tagIds, tags],
  );

  /**
   * The services the rows on this plan are **effectively** delivered by, plus
   * whatever is already ticked.
   *
   * Off `row.facets.serviceIds` and so off the effective reading, which is what
   * makes the offered list match what ticking one will find: a plan whose only
   * stored service sits on a parent still offers it, because every child under
   * that parent answers to it.
   */
  const facetServices = useMemo(
    () =>
      optionsFor(
        new Set(narrowable.flatMap((row) => row.facets.serviceIds)),
        facets.serviceIds,
        (id) =>
          services.find((each) => each.id === id)?.name ?? 'a service this plan has not loaded',
      ),
    [narrowable, facets.serviceIds, services],
  );

  const facetPeople = useMemo(
    () =>
      optionsFor(
        new Set(narrowable.flatMap((row) => row.facets.assigneeIds)),
        facets.assigneeIds,
        // The names that came with the tree, which is be-01's own list of who
        // is assigned on this plan — not the directory's list of everybody.
        (id) =>
          chartRead.people.find((person) => person.id === id)?.name ??
          'somebody this plan has not loaded',
      ),
    [narrowable, facets.assigneeIds, chartRead.people],
  );

  /** In the ladder's order, which is the order the bands mean something in. */
  const facetBands = useMemo(() => {
    const present = new Set(
      narrowable.flatMap((row) =>
        row.facets.priorityBand === null ? [] : [row.facets.priorityBand],
      ),
    );
    return priorityBands
      .filter((band) => present.has(band.label) || facets.priorityBands.includes(band.label))
      .map((band) => ({ id: band.label, label: band.label }));
  }, [narrowable, priorityBands, facets.priorityBands]);

  /** In the step list's order, which is the order of the columns they estimate. */
  const facetSteps = useMemo(() => {
    const present = new Set(narrowable.flatMap((row) => row.facets.estimatedStepIds));
    return steps
      .filter((step) => present.has(step.id) || facets.estimatedStepIds.includes(step.id))
      .map((step) => ({ id: step.id, label: step.name }));
  }, [narrowable, steps, facets.estimatedStepIds]);
  return {
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
  };
}
