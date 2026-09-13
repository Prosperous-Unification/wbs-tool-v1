import type { ExpandedState } from '@tanstack/react-table';

/**
 * The facts about one work item a filter is allowed to ask about — R10 §9's
 * Q8 seven, the tag dimension, and the service dimension with its two signals.
 * Ten, and nothing else.
 *
 * **Every one of them is already on the wire**, and that is why this interface
 * is a description rather than a fetch: the whole tree is client-side, so
 * `wbs-table.tsx` reads each field off the row it already holds and hands the
 * answers over. `status` is deliberately absent — there is no such field in
 * `work_item` or in `WorkItemView`, and deriving one from "has dates" or
 * "fully estimated" would put a word on screen the data does not support
 * (`notes/wbs-brief-2026-08-17-r10-filtering.md` §1, §8.8).
 *
 * The grain is a **row**, never a slice. Assignee, step and critical are facts
 * about a slice; a row carries the union of its slices' answers, so a row
 * matches when *any* of its work does and every one of its bars is then drawn.
 * Filtering at slice grain would draw a row with some of its bars removed,
 * which under-reports the row's span and makes the summary bracket a lie (§4).
 */
export interface RowFacets {
  /**
   * The teams whose work this is — the **effective**, inherited reading
   * (`effectiveTeamsOf`), never the row's own stored label.
   *
   * A leaf that draws its slots from an ancestor's pool would otherwise vanish
   * from a filter for the team whose people are doing its work. The
   * stored-versus-effective distinction has already caused that class of bug
   * twice in this repo (§8.5).
   */
  teamIds: readonly string[];
  /**
   * What kind of thing this row is — the **effective**, inherited reading
   * (`effectiveTagsOf`), never the row's own stored labels.
   *
   * The same rule as `teamIds` above and for the same reason, which is the one
   * this repo has shipped wrong twice: a leaf under a `regulatory` parent *is*
   * regulatory, and a filter reading stored labels would not find it.
   *
   * **The two dimensions no longer take the identical reading**, since ADR 0008:
   * this one is the **union** of the row's own tags and every ancestor's, so a
   * leaf that states `Ready` under a `regulatory` parent answers a filter for
   * either word. The team facet is still the nearest statement alone, and the
   * two walks are two files — `effective-tag.ts` here, `effective-label.ts`
   * there.
   */
  tagIds: readonly string[];
  /**
   * What this row delivers — the **effective**, inherited reading
   * (`effectiveServicesOf`), never `work_item.service_id` straight off the row.
   *
   * The same rule and now the same shape as `teamIds` and `tagIds` above — a
   * set, empty where nobody above this row has said (Dany, 2026-08-21, "can be
   * several services"). It was a single nullable id until chunk 12, and the
   * predicate below already treated it as a set of nought or one, which is why
   * widening it cost this field and one line.
   */
  serviceIds: readonly string[];
  /**
   * What kind of work this row **is** — the row's **own** types, and this is the
   * one facet in this interface that is not an effective reading.
   *
   * Not an oversight and not a shortcut: a work item type does not inherit, so
   * there is no walk to take and the stored set already **is** the effective one
   * (`docs/adr/0009-a-work-item-type-does-not-inherit-at-all.md`). The three
   * fields above carry a warning that reading stored labels finds the parent and
   * loses every child; here there is no child to lose, because a child of an
   * `Epic` is not an `Epic`.
   */
  typeIds: readonly string[];
  /**
   * Whether the teams doing this row's work own the service it delivers —
   * `builtByNonOwner` over the effective reading of both, against the
   * directory's ownership map.
   *
   * Precomputed per row rather than derived inside `narrowTree` for
   * {@link RowFacets}' whole reason: the walker's business is ancestors and
   * termination, and the directory map is not a fact about a tree. False where
   * either fact is unstated — absence is not a mismatch, and
   * `libs/domain/src/label-mismatch.ts` owns the rule.
   */
  builtByNonOwner: boolean;
  /**
   * Whether anybody named on this row belongs to none of the teams doing its
   * work — `assignedOutsideTeam`, the second signal and the same vocabulary.
   */
  assignedOutsideTeam: boolean;
  /** Everybody named on any of this row's steps, deduplicated. */
  assigneeIds: readonly string[];
  /** What this plan's ladder calls this row's priority, or null where nobody has said. */
  priorityBand: string | null;
  /** The steps this row carries an estimate for — `Object.hasOwn`, the same reading `findEstimateGaps` makes. */
  estimatedStepIds: readonly string[];
  /** Whether this row is one of the leaves the readiness badge counts. */
  unestimated: boolean;
  /** Whether any of this row's work is on the critical path. */
  critical: boolean;
}

/** A work item as the filter reads it: what it is called, where it hangs, and what it is. */
export interface NarrowableRow {
  id: string;
  name: string;
  parentId: string | null;
  facets: RowFacets;
}

/**
 * What is being asked of the plan: a typed name, and any of ten facets.
 *
 * **Within one facet the chosen values are OR** — two teams ticked is "either
 * of these teams", which is what a list of checkboxes means anywhere else.
 * **Across facets, and against the name, it is AND**: every active criterion
 * has to hold, because each tick a reader adds is a narrowing they asked for,
 * and a filter that widened as you ticked would be unusable.
 *
 * An empty list, an empty string and `false` each mean **that criterion is not
 * being asked about at all** — not "nothing matches it". There is deliberately
 * no separate "is this facet on" flag: two ways to say the same thing is how
 * the control and the predicate start to disagree.
 */
export interface FilterCriteria {
  query: string;
  teamIds: readonly string[];
  /** Tag ids — the vocabulary is global, so an id means the same thing on every plan. */
  tagIds: readonly string[];
  /**
   * Service ids — a **list**, where the row's own service is a single value.
   *
   * Ticking two services is "either of these", which is what a list of
   * checkboxes means in the five facets beside it; that a row can only answer
   * with one of them is the row's business, not the control's.
   */
  serviceIds: readonly string[];
  /** Type ids — the vocabulary is global, so an id means the same thing on every plan. */
  typeIds: readonly string[];
  /**
   * Only rows built by a team that does not own the service they deliver.
   *
   * A boolean like `unestimated` and `critical` and not a list, because there
   * is one question to ask: `false` is not asking it. The **inverse is
   * deliberately not offered** — "only work its owners built" is a claim about
   * a map that ships empty, and on a plan where nobody has filled the ownership
   * in it would answer with the whole table and look like it worked.
   */
  builtByNonOwner: boolean;
  /** Only rows naming somebody outside the teams doing the work — the second signal. */
  assignedOutsideTeam: boolean;
  assigneeIds: readonly string[];
  /** Band **labels**, not start values — what the ladder calls the rung, which is what the control offers. */
  priorityBands: readonly string[];
  estimatedStepIds: readonly string[];
  unestimated: boolean;
  critical: boolean;
}

/** The ten criteria that are not the typed name, which have one control between them. */
export type FacetCriteria = Omit<FilterCriteria, 'query'>;

/**
 * No facet ticked — the ten that are not the typed name.
 *
 * Its own constant because the Find box is its own state in `wbs-table.tsx`
 * (Escape empties it, and it is the one criterion with a control of its own),
 * so "clear the facets" and "clear everything" are two gestures and each needs
 * a starting point to be stated against.
 */
export const NO_FACETS: FacetCriteria = {
  teamIds: [],
  tagIds: [],
  serviceIds: [],
  typeIds: [],
  builtByNonOwner: false,
  assignedOutsideTeam: false,
  assigneeIds: [],
  priorityBands: [],
  estimatedStepIds: [],
  unestimated: false,
  critical: false,
};

/** Nothing asked of the plan, which is what every reader starts with on every load. */
export const NO_FILTER: FilterCriteria = { query: '', ...NO_FACETS };

/**
 * What one filter does to the tree.
 *
 * `visibleIds` is every row that stays on screen — the matches, the ancestors
 * that place them and (for a typed name alone) the descendants beneath them.
 * `matchIds` is only the rows that answered the filter themselves, so the table
 * and the cards can mark them: the rest are context, and marking them too would
 * make the mark mean nothing.
 *
 * `expandedOverlay` is the expansion the table must render **while the filter
 * is on**, in place of the reader's own. Null means nothing is being asked and
 * the reader's own expansion stands — the overlay is never merged into it,
 * which is what lets clearing the filter put the plan back exactly as it was
 * left.
 */
export interface TreeNarrowing {
  visibleIds: ReadonlySet<string>;
  matchIds: ReadonlySet<string>;
  expandedOverlay: ExpandedState | null;
}

/** Whether any facet is being asked about — the name is asked separately. */
function anyFacetChosen(criteria: FilterCriteria): boolean {
  return (
    criteria.teamIds.length > 0 ||
    criteria.tagIds.length > 0 ||
    criteria.serviceIds.length > 0 ||
    criteria.typeIds.length > 0 ||
    criteria.builtByNonOwner ||
    criteria.assignedOutsideTeam ||
    criteria.assigneeIds.length > 0 ||
    criteria.priorityBands.length > 0 ||
    criteria.estimatedStepIds.length > 0 ||
    criteria.unestimated ||
    criteria.critical
  );
}

/**
 * Whether this filter is asking anything at all.
 *
 * The one answer to "is a filter on", shared by the narrowing below and by
 * every control that stands down while one is (the triangles, Collapse all,
 * Expand all). A second trim or a second count beside it is how two answers to
 * one question start to disagree.
 */
export function isFiltering(criteria: FilterCriteria): boolean {
  return criteria.query.trim() !== '' || anyFacetChosen(criteria);
}

/**
 * The names the ids in a {@link FilterCriteria} stand for, as the surface that
 * holds them can say them.
 *
 * Handed in rather than looked up here for {@link RowFacets}' reason: this
 * module knows about trees and predicates, and a walker that also knew what a
 * team was called would be two things. The lists it would have to hold are the
 * directory's, the chart read's and the project's ladder — three separate
 * moments, none of them a fact about a tree.
 */
export interface FilterLabels {
  teamName: (teamId: string) => string;
  tagName: (tagId: string) => string;
  serviceName: (serviceId: string) => string;
  typeName: (typeId: string) => string;
  personName: (personId: string) => string;
  stepName: (stepId: string) => string;
}

/**
 * What is being asked of the plan, in words — one phrase per criterion that is
 * asking anything, and an empty list when nothing is.
 *
 * Written for a **document**: the filtered export's header line has to say what
 * was filtered, or it is a plan with rows missing and nothing admitting it,
 * which is exactly what R10 §9's Q3 refused. The screen has the control itself
 * to look at; a Markdown file somebody was sent has only this sentence.
 *
 * Values inside one phrase are joined with `or` and the phrases are a list, so
 * the words carry the same OR-within, AND-across reading the predicate has
 * ({@link FilterCriteria}) rather than a second, friendlier, wrong one.
 */
export function filterWords(criteria: FilterCriteria, labels: FilterLabels): string[] {
  const words: string[] = [];
  const wanted = criteria.query.trim();
  if (wanted !== '') words.push(`name contains “${wanted}”`);
  /** One facet's chosen values, named and joined — nothing at all where none were. */
  const chosen = (title: string, ids: readonly string[], nameOf: (id: string) => string): void => {
    if (ids.length === 0) return;
    words.push(`${title} ${ids.map(nameOf).join(' or ')}`);
  };
  chosen('team', criteria.teamIds, labels.teamName);
  // "tag regulatory or tech-debt" — its own phrase beside the team's, because
  // the two dimensions are independent and a document folding them into one
  // would say something neither the control nor the predicate means.
  chosen('tag', criteria.tagIds, labels.tagName);
  // The third dimension's own phrase, beside the other two and never folded in
  // with them: team, tag and service are independent, and a document saying
  // "team Platform or Payments" for a team and a service would be a sentence
  // neither the control nor the predicate means.
  chosen('service', criteria.serviceIds, labels.serviceName);
  // The fourth dimension's own phrase, for the third's reason: independent of
  // the three beside it, so folding it in would say something neither the
  // control nor the predicate means.
  chosen('type', criteria.typeIds, labels.typeName);
  chosen('assignee', criteria.assigneeIds, labels.personName);
  // The bands travel as their labels rather than as ids — what the ladder calls
  // the rung is what the control offers and what a reader recognises.
  chosen('priority band', criteria.priorityBands, (band) => band);
  chosen('estimated for', criteria.estimatedStepIds, labels.stepName);
  if (criteria.unestimated) words.push('unestimated only');
  if (criteria.critical) words.push('on the critical path only');
  // Last, and phrased as what the rows have in common rather than as a facet
  // name: an export's reader has the sentence and not the panel, and "built by
  // a non-owner" is the fact, where "built by non-owner: yes" is a checkbox.
  if (criteria.builtByNonOwner) words.push('built by a non-owner only');
  if (criteria.assignedOutsideTeam) words.push('assigned outside the team only');
  return words;
}

/** Whether a row carries any of the values chosen — and true where none were. */
function carriesAnyChosen(chosen: readonly string[], carried: readonly string[]): boolean {
  if (chosen.length === 0) return true;
  return carried.some((each) => chosen.includes(each));
}

/**
 * Narrows a flat list of rows to what a filter is asking about, and says what
 * has to be open for the answer to be on screen.
 *
 * Three rules make one narrowed tree, and the second and third are what stop it
 * lying:
 *
 * 1. A row **matches** when it answers **every** active criterion: its name
 *    contains the query, case-insensitively — the same `trim().toLowerCase()`
 *    substring every other filter in this repo uses ({@link matchingProjects},
 *    {@link pickerEntries}) — *and* it carries one of each chosen facet's
 *    values. See {@link FilterCriteria} for why within-facet is OR and
 *    across-facet is AND.
 * 2. Every **ancestor** of a match is kept, under every criterion. A match
 *    shown without the rows above it is a work item torn out of the plan that
 *    gives it its meaning, and its indent and its number would then describe a
 *    tree that is not on screen.
 * 3. Every **descendant** of a match is kept **only while a typed name is the
 *    whole of the filter**. Typing `Kitchen` is how a person asks for a whole
 *    branch, and answering with the parent alone would hide the work it is a
 *    heading for. Ticking `assignee = Ada` is not: a parent row that happens to
 *    name Ada on one step would drag in forty rows nobody assigned to her, and
 *    the count beside the box would read `47 of 60` for a filter with three
 *    real hits. So the moment any facet is ticked — with or without a name
 *    beside it — this rule stands down and the filter is a per-row question.
 *    R10 §4 and §9's Q2, Dany 2026-08-17.
 *
 * Anything else is hidden — including, when nothing matches at all, everything.
 * A filter that falls back to the whole table on no match reads as broken: the
 * typing appears to have done nothing.
 *
 * The overlay opens **every kept row**, not only the ancestors. Both are needed:
 * a match inside a branch the reader had closed has to be revealed, and a
 * matched parent's subtree has to be open for rule 3 to be visible. Every kept
 * row's parent is itself kept — ancestors by rule 2, descendants by the chain
 * they hang from — so opening the kept set is exactly enough to render it.
 *
 * Pure, and re-derived from the rows handed in on every call. The tree refetches
 * on every edit by anybody, and a remembered answer would narrow to a plan that
 * no longer exists.
 *
 * Terminates on any list, including one whose `parentId`s form a cycle: the
 * ancestor walk stops at a row it has already stepped on, and the descendant
 * walk queues each row once. `toTree` leaves a cycle out of the tree entirely,
 * so the table cannot hand one over today — but a hang here would be a frozen
 * tab, which is worse than any wrong answer this could give.
 */
export function narrowTree(
  rows: readonly NarrowableRow[],
  criteria: FilterCriteria,
): TreeNarrowing {
  const wanted = criteria.query.trim().toLowerCase();
  if (!isFiltering(criteria)) {
    return {
      visibleIds: new Set(rows.map((row) => row.id)),
      matchIds: new Set(),
      expandedOverlay: null,
    };
  }

  const byId = new Map(rows.map((row) => [row.id, row]));
  const childrenOf = new Map<string, string[]>();
  for (const row of rows) {
    if (row.parentId === null) continue;
    const siblings = childrenOf.get(row.parentId);
    if (siblings === undefined) childrenOf.set(row.parentId, [row.id]);
    else siblings.push(row.id);
  }

  const matches = (row: NarrowableRow): boolean =>
    (wanted === '' || row.name.toLowerCase().includes(wanted)) &&
    carriesAnyChosen(criteria.teamIds, row.facets.teamIds) &&
    // Against `row.facets.tagIds`, which is the **effective** reading — see
    // {@link RowFacets.tagIds}. Pointed at a row's own stored labels this finds
    // the parent and loses every child under it.
    carriesAnyChosen(criteria.tagIds, row.facets.tagIds) &&
    // Against `row.facets.serviceIds`, the **effective** reading, and now a set
    // like the two above it. Pointed at the row's own stored column this finds
    // the parent that states a service and loses every child delivering it by
    // inheritance (task 6.2). `carriesAnyChosen` is an intersection, so a row
    // delivering two services answers to a tick on either.
    carriesAnyChosen(criteria.serviceIds, row.facets.serviceIds) &&
    // Against `row.facets.typeIds`, which is the row's **own** set — and unlike
    // the three above, that is the whole reading rather than half of one. There
    // is no inheritance to lose a child to here.
    carriesAnyChosen(criteria.typeIds, row.facets.typeIds) &&
    carriesAnyChosen(criteria.assigneeIds, row.facets.assigneeIds) &&
    carriesAnyChosen(
      criteria.priorityBands,
      row.facets.priorityBand === null ? [] : [row.facets.priorityBand],
    ) &&
    carriesAnyChosen(criteria.estimatedStepIds, row.facets.estimatedStepIds) &&
    (!criteria.unestimated || row.facets.unestimated) &&
    (!criteria.critical || row.facets.critical) &&
    // The two signals read as `unestimated` and `critical` do — an unticked box
    // asks nothing, and a ticked one keeps only the rows that answer yes. The
    // booleans are computed on the row (see {@link RowFacets.builtByNonOwner});
    // this module never sees the ownership map.
    (!criteria.builtByNonOwner || row.facets.builtByNonOwner) &&
    (!criteria.assignedOutsideTeam || row.facets.assignedOutsideTeam);

  const matchIds = new Set(rows.filter(matches).map((row) => row.id));
  const visibleIds = new Set<string>(matchIds);

  // Proof: this walk removed, `keeps the rows that place a match deep in the
  // tree`, `opens every kept row…` and `hides a row that neither matches nor
  // sits on a match’s line` failed here, and seven table tests failed with
  // `Back boxes` shown as a root of a plan it is three levels inside. Watched,
  // 2026-08-06.
  for (const matched of matchIds) {
    const steppedOn = new Set<string>([matched]);
    let above = byId.get(matched)?.parentId ?? null;
    while (above !== null && !steppedOn.has(above)) {
      // A `parentId` naming a row this list does not hold is the top of the
      // tree as far as this list goes — `toTree` renders such a row at the
      // root. Keeping the id anyway would put a row that does not exist into
      // the kept set and into the count beside the box.
      const parent = byId.get(above);
      if (parent === undefined) break;
      steppedOn.add(above);
      visibleIds.add(above);
      above = parent.parentId;
    }
  }

  // Rule 3, and the whole of what a facet changes about the tree: a ticked
  // facet is a question about each row, so nothing is seeded and no subtree
  // comes with a match.
  //
  // Proof: the guard removed, `a facet does not bring the subtree under a row
  // that matched it` failed with all four rows of the branch visible, and
  // `a name beside a facet stops bringing its subtree` failed on the same
  // count. Watched, 2026-08-17.
  //
  // Queued rather than recursive, and each row queued once: `walked` is what
  // keeps a row that is both a match's ancestor and another match's descendant
  // from being walked twice, and a cycle from being walked forever.
  if (!anyFacetChosen(criteria)) {
    const queue = [...matchIds];
    const walked = new Set(matchIds);
    while (queue.length > 0) {
      const under = queue.pop();
      if (under === undefined) break;
      for (const child of childrenOf.get(under) ?? []) {
        visibleIds.add(child);
        if (walked.has(child)) continue;
        walked.add(child);
        queue.push(child);
      }
    }
  }

  // Nothing matched leaves `visibleIds` empty, and that is the answer.
  // Proof: given a fall-back to every row when `matchIds` is empty, `hides
  // everything when nothing matches, rather than showing everything` failed
  // here, and `shows an empty table and says so when nothing matches` and
  // `re-derives from the rows that came back…` failed in the table. Watched,
  // 2026-08-06.
  return {
    visibleIds,
    matchIds,
    expandedOverlay: Object.fromEntries([...visibleIds].map((id) => [id, true])),
  };
}
