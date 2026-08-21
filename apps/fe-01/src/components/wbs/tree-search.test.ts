import { describe, expect, it } from 'vitest';

import {
  type FilterCriteria,
  filterWords,
  isFiltering,
  type NarrowableRow,
  narrowTree,
  NO_FILTER,
  type RowFacets,
} from './tree-search';

/** A row carrying no facet at all, which is what every row is unless a test says otherwise. */
const NO_FACETS: RowFacets = {
  teamIds: [],
  tagIds: [],
  serviceIds: [],
  builtByNonOwner: false,
  assignedOutsideTeam: false,
  assigneeIds: [],
  priorityBand: null,
  estimatedRoleIds: [],
  unestimated: false,
  critical: false,
};

const row = (
  id: string,
  parentId: string | null,
  name: string,
  facets: Partial<RowFacets> = {},
): NarrowableRow => ({
  id,
  parentId,
  name,
  facets: { ...NO_FACETS, ...facets },
});

/** What is being asked, stated as the difference from asking nothing. */
const asking = (criteria: Partial<FilterCriteria>): FilterCriteria => ({
  ...NO_FILTER,
  ...criteria,
});

/**
 * A small plan with a match three levels down and a branch with nothing in it.
 *
 * ```
 * a   Strip the walls
 *  a1  Sockets
 *   a11 Back boxes
 *  a2  Skirting
 * b   Paint
 *  b1  Undercoat
 * ```
 */
const PLAN: NarrowableRow[] = [
  row('a', null, 'Strip the walls'),
  row('a1', 'a', 'Sockets'),
  row('a11', 'a1', 'Back boxes'),
  row('a2', 'a', 'Skirting'),
  row('b', null, 'Paint'),
  row('b1', 'b', 'Undercoat'),
];

/**
 * The same shape, with facets on it: `a` is Platform's and Ada is on it, and
 * the rows under it carry nothing of their own.
 */
const FACETED: NarrowableRow[] = [
  row('a', null, 'Strip the walls', {
    teamIds: ['platform'],
    assigneeIds: ['ada'],
    priorityBand: 'High',
    estimatedRoleIds: ['dev'],
    critical: true,
  }),
  row('a1', 'a', 'Sockets', { unestimated: true }),
  row('a11', 'a1', 'Back boxes', { teamIds: ['payments'], assigneeIds: ['bo'] }),
  row('a2', 'a', 'Skirting', { priorityBand: 'Low' }),
  row('b', null, 'Paint', { teamIds: ['payments'], estimatedRoleIds: ['dev', 'qa'] }),
  row('b1', 'b', 'Undercoat', { assigneeIds: ['ada'], unestimated: true, critical: true }),
];

const ids = (of: ReadonlySet<string>): string[] => [...of].sort();

describe('isFiltering', () => {
  it('is false for nothing asked and for a query of nothing but spaces', () => {
    expect(isFiltering(NO_FILTER)).toBe(false);
    expect(isFiltering(asking({ query: '   ' }))).toBe(false);
  });

  it('is true for a facet with no query beside it', () => {
    // The whole of what R10 adds: a filter that is on while the Find box is
    // empty. A `searching` flag that only read the query would leave the
    // triangles live and the count silent under every facet.
    expect(isFiltering(asking({ teamIds: ['platform'] }))).toBe(true);
    expect(isFiltering(asking({ critical: true }))).toBe(true);
    expect(isFiltering(asking({ unestimated: true }))).toBe(true);
  });
});

describe('narrowTree — a typed name', () => {
  it('keeps every row and asks for no expansion when nothing is asked', () => {
    const narrowed = narrowTree(PLAN, NO_FILTER);

    expect(ids(narrowed.visibleIds)).toEqual(['a', 'a1', 'a11', 'a2', 'b', 'b1']);
    expect(ids(narrowed.matchIds)).toEqual([]);
    // Null, not `true`: nothing is being asked, so the reader's own collapse
    // state stands. An overlay of `true` here would silently open every
    // branch the moment the box was focused and emptied again.
    expect(narrowed.expandedOverlay).toBeNull();
  });

  it('treats a query of nothing but spaces as no filter at all', () => {
    // The same `trim().toLowerCase()` rule the project picker and the Depends
    // on picker apply. Two filters side by side that disagree about a space is
    // a surprise with nothing to gain from it.
    const narrowed = narrowTree(PLAN, asking({ query: '   ' }));

    expect(ids(narrowed.visibleIds)).toEqual(['a', 'a1', 'a11', 'a2', 'b', 'b1']);
    expect(narrowed.expandedOverlay).toBeNull();
  });

  it('keeps the rows that place a match deep in the tree', () => {
    // The requirement the change exists for: a narrowed tree that dropped the
    // ancestors would show `Back boxes` floating at the root of a plan it is
    // three levels inside, which is a tree lying about its own shape.
    const narrowed = narrowTree(PLAN, asking({ query: 'back' }));

    expect(ids(narrowed.visibleIds)).toEqual(['a', 'a1', 'a11']);
    expect(ids(narrowed.matchIds)).toEqual(['a11']);
  });

  it('opens every kept row, so a match inside a closed branch is on screen', () => {
    const narrowed = narrowTree(PLAN, asking({ query: 'back' }));

    expect(narrowed.expandedOverlay).toEqual({ a: true, a1: true, a11: true });
  });

  it('shows the whole subtree under a matched parent', () => {
    const narrowed = narrowTree(PLAN, asking({ query: 'strip the' }));

    expect(ids(narrowed.visibleIds)).toEqual(['a', 'a1', 'a11', 'a2']);
    // Only the row whose own name matched is a hit. The three under it are
    // there because their parent matched, and marking them would make the
    // mark mean nothing.
    expect(ids(narrowed.matchIds)).toEqual(['a']);
    expect(narrowed.expandedOverlay).toEqual({ a: true, a1: true, a11: true, a2: true });
  });

  it('matches without regard to case', () => {
    const narrowed = narrowTree(PLAN, asking({ query: 'SOCKets' }));

    expect(ids(narrowed.matchIds)).toEqual(['a1']);
  });

  it('hides a row that neither matches nor sits on a match’s line', () => {
    const narrowed = narrowTree(PLAN, asking({ query: 'skirting' }));

    // `a` places the match; everything under `b` and the whole `a1` branch are
    // unrelated to it and go.
    expect(ids(narrowed.visibleIds)).toEqual(['a', 'a2']);
  });

  it('hides everything when nothing matches, rather than showing everything', () => {
    // A filter that falls back to the unfiltered table on no match reads as
    // broken — the typing appears to have done nothing. An empty table plus a
    // sentence saying so is the honest answer.
    const narrowed = narrowTree(PLAN, asking({ query: 'plumbing' }));

    expect(ids(narrowed.visibleIds)).toEqual([]);
    expect(ids(narrowed.matchIds)).toEqual([]);
    expect(narrowed.expandedOverlay).toEqual({});
  });

  it('finds a match whose parent is not in the list', () => {
    // `toTree` keeps a row whose parent is missing at the root rather than
    // dropping it, so this list is one the table really can hand over.
    const orphaned = [row('x', 'gone', 'Rewire the shed')];

    const narrowed = narrowTree(orphaned, asking({ query: 'shed' }));

    expect(ids(narrowed.visibleIds)).toEqual(['x']);
  });

  it('terminates on a parent cycle instead of walking it forever', () => {
    // `toTree` leaves both rows of a cycle out of the tree, so the table
    // cannot hand one over today. This is pure and takes the list it is given:
    // a hang here would be a frozen tab, which is worse than any wrong answer.
    const looped = [row('p', 'q', 'Plaster'), row('q', 'p', 'Prime')];

    const narrowed = narrowTree(looped, asking({ query: 'plaster' }));

    expect(ids(narrowed.visibleIds)).toEqual(['p', 'q']);
    expect(ids(narrowed.matchIds)).toEqual(['p']);
  });

  it('counts one row once when it is both an ancestor and a descendant of a match', () => {
    // `a1` is kept as `a11`'s ancestor and again as matched `a`'s descendant.
    const narrowed = narrowTree(PLAN, asking({ query: 'walls' }));

    expect(ids(narrowed.visibleIds)).toEqual(['a', 'a1', 'a11', 'a2']);
  });
});

describe('narrowTree — the facets', () => {
  it('keeps a facet match’s ancestors, and not its subtree', () => {
    // R10 §4, Dany 2026-08-17: `Kitchen` means the kitchen branch, and
    // `team = Platform` does not mean everything under a row Platform happens
    // to be labelled with. `a` matched; `a1`, `a11` and `a2` are not
    // Platform's and go, while nothing above `a` is dropped.
    const narrowed = narrowTree(FACETED, asking({ teamIds: ['platform'] }));

    expect(ids(narrowed.visibleIds)).toEqual(['a']);
    expect(ids(narrowed.matchIds)).toEqual(['a']);
  });

  it('keeps the ancestors that place a facet match deep in the tree', () => {
    const narrowed = narrowTree(FACETED, asking({ teamIds: ['payments'] }));

    // `a11` is Payments'; `a` and `a1` are the rows that place it, and neither
    // is marked.
    expect(ids(narrowed.visibleIds)).toEqual(['a', 'a1', 'a11', 'b']);
    expect(ids(narrowed.matchIds)).toEqual(['a11', 'b']);
  });

  it('takes any of the values ticked within one facet', () => {
    const narrowed = narrowTree(FACETED, asking({ teamIds: ['platform', 'payments'] }));

    expect(ids(narrowed.matchIds)).toEqual(['a', 'a11', 'b']);
  });

  it('takes only the rows answering every facet ticked', () => {
    // Across facets it is AND: `b` is Payments' but has no assignee, `b1` has
    // Ada but no team of its own.
    const narrowed = narrowTree(FACETED, asking({ teamIds: ['payments'], assigneeIds: ['bo'] }));

    expect(ids(narrowed.matchIds)).toEqual(['a11']);
  });

  it('finds a person on any of a row’s phases', () => {
    const narrowed = narrowTree(FACETED, asking({ assigneeIds: ['ada'] }));

    expect(ids(narrowed.matchIds)).toEqual(['a', 'b1']);
  });

  it('finds a band by what the ladder calls it', () => {
    const narrowed = narrowTree(FACETED, asking({ priorityBands: ['High'] }));

    expect(ids(narrowed.matchIds)).toEqual(['a']);
  });

  it('never matches an unprioritised row on a band', () => {
    // A row nobody has prioritised carries no band, and a filter that swept it
    // into one would put a word on screen the plan never said.
    const narrowed = narrowTree(FACETED, asking({ priorityBands: ['High', 'Low'] }));

    expect(ids(narrowed.matchIds)).toEqual(['a', 'a2']);
  });

  it('finds the rows carrying an estimate for a phase', () => {
    const narrowed = narrowTree(FACETED, asking({ estimatedRoleIds: ['qa'] }));

    expect(ids(narrowed.matchIds)).toEqual(['b']);
  });

  it('finds the leaves the readiness badge counts', () => {
    const narrowed = narrowTree(FACETED, asking({ unestimated: true }));

    expect(ids(narrowed.matchIds)).toEqual(['a1', 'b1']);
    // `a` is `a1`'s ancestor and `b` is `b1`'s: both stay as context.
    expect(ids(narrowed.visibleIds)).toEqual(['a', 'a1', 'b', 'b1']);
  });

  it('finds the rows with work on the critical path', () => {
    const narrowed = narrowTree(FACETED, asking({ critical: true }));

    expect(ids(narrowed.matchIds)).toEqual(['a', 'b1']);
  });

  it('hides everything when no row answers a facet', () => {
    const narrowed = narrowTree(FACETED, asking({ teamIds: ['nobody-else'] }));

    expect(ids(narrowed.visibleIds)).toEqual([]);
    expect(narrowed.expandedOverlay).toEqual({});
  });

  it('opens every kept row under a facet too', () => {
    const narrowed = narrowTree(FACETED, asking({ teamIds: ['payments'] }));

    expect(narrowed.expandedOverlay).toEqual({ a: true, a1: true, a11: true, b: true });
  });
});

describe('narrowTree — a name and a facet together', () => {
  it('takes only the rows answering both', () => {
    // `Strip the walls` matches the name and is Platform's; `Paint` is
    // Payments' and does not match the name.
    const narrowed = narrowTree(FACETED, asking({ query: 'a', teamIds: ['platform'] }));

    expect(ids(narrowed.matchIds)).toEqual(['a']);
  });

  it('stops bringing the subtree the name alone would have brought', () => {
    // The one semantic split inside this function, and the case it exists for
    // (R10 §8.4): the same query with no facet beside it keeps all four rows
    // of the branch, and one tick turns the filter into a per-row question.
    const named = narrowTree(FACETED, asking({ query: 'strip the' }));
    expect(ids(named.visibleIds)).toEqual(['a', 'a1', 'a11', 'a2']);

    const narrowed = narrowTree(FACETED, asking({ query: 'strip the', teamIds: ['platform'] }));

    expect(ids(narrowed.visibleIds)).toEqual(['a']);
    expect(ids(narrowed.matchIds)).toEqual(['a']);
  });

  it('still keeps the ancestors of a row that answers both', () => {
    const narrowed = narrowTree(FACETED, asking({ query: 'back', teamIds: ['payments'] }));

    expect(ids(narrowed.visibleIds)).toEqual(['a', 'a1', 'a11']);
    expect(ids(narrowed.matchIds)).toEqual(['a11']);
  });
});

describe('what the filter says it is asking', () => {
  /** The names the ids stand for, as the table resolves them for an export. */
  const LABELS = {
    teamName: (id: string) => (id === 'platform' ? 'Platform' : 'Payments'),
    personName: (id: string) => (id === 'ada' ? 'Ada' : 'Kat'),
    phaseName: (id: string) => (id === 'dev' ? 'Dev' : 'QA'),
  };

  it('says nothing while nothing is being asked', () => {
    expect(filterWords(NO_FILTER, LABELS)).toEqual([]);
  });

  it('names every criterion that is asking, in the words the control uses', () => {
    const words = filterWords(
      asking({
        query: '  kitchen  ',
        teamIds: ['platform', 'payments'],
        assigneeIds: ['ada'],
        priorityBands: ['Critical'],
        estimatedRoleIds: ['qa'],
        unestimated: true,
        critical: true,
      }),
      LABELS,
    );

    // `or` inside a facet and one phrase per facet, which is the predicate's
    // own OR-within, AND-across reading rather than a friendlier wrong one.
    expect(words).toEqual([
      'name contains “kitchen”',
      'team Platform or Payments',
      'assignee Ada',
      'priority band Critical',
      'estimated for QA',
      'unestimated only',
      'on the critical path only',
    ]);
  });

  it('leaves out a facet nothing was chosen from', () => {
    expect(filterWords(asking({ assigneeIds: ['kat'] }), LABELS)).toEqual(['assignee Kat']);
  });
});

describe('the tag facet narrows like every other facet', () => {
  /**
   * A tree whose rows already carry the **effective** reading, because that is
   * what {@link RowFacets} is: `wbs-table.tsx` runs `effectiveTagsOf` and hands
   * the answers over, and this module never sees a stored label.
   *
   * So the inheritance itself is **not** asserted here — it cannot be, at this
   * layer. `a1` and `a11` carry `regulatory` below because the row builder one
   * level up put it there, and the test that the builder really does that is in
   * `wbs-table.test.tsx`, where `effectiveTagsOf` actually runs. Writing it here
   * first was a mistake worth leaving a note about: the fixture stated the
   * children's tags itself, so it would have passed against a build that read
   * stored labels everywhere.
   */
  const INHERITED: NarrowableRow[] = [
    row('a', null, 'Rewire the consumer unit', { tagIds: ['regulatory'] }),
    row('a1', 'a', 'Sockets', { tagIds: ['regulatory'] }),
    row('a11', 'a1', 'Back boxes', { tagIds: ['regulatory'] }),
    row('b', null, 'Paint', { tagIds: ['tech-debt'] }),
  ];

  it('keeps every row in force for the tag, and the rows that place them', () => {
    const narrowed = narrowTree(INHERITED, asking({ tagIds: ['regulatory'] }));

    expect(ids(narrowed.matchIds)).toEqual(['a', 'a1', 'a11']);
    expect(ids(narrowed.visibleIds)).toEqual(['a', 'a1', 'a11']);
  });

  it('is OR within the facet and AND against another', () => {
    // The reading every other facet has, asserted for this one rather than
    // assumed: two tags ticked is either of them, and a tag beside a team is
    // both.
    expect(
      ids(narrowTree(INHERITED, asking({ tagIds: ['regulatory', 'tech-debt'] })).matchIds),
    ).toEqual(['a', 'a1', 'a11', 'b']);
    expect(
      ids(
        narrowTree(INHERITED, asking({ tagIds: ['regulatory'], teamIds: ['platform'] })).matchIds,
      ),
    ).toEqual([]);
  });

  it('narrows to nothing for a tag no row carries, rather than to everything', () => {
    // A tag deleted from the directory while a saved view still names it. Empty
    // means empty — the same rule every other facet takes.
    expect(ids(narrowTree(INHERITED, asking({ tagIds: ['gone'] })).matchIds)).toEqual([]);
  });

  it('says what it is asking, in its own phrase', () => {
    // The filtered export's `Scope` line. Its own phrase beside the team's,
    // because folding two independent dimensions into one would describe a
    // filter neither the control nor the predicate means.
    expect(
      filterWords(asking({ teamIds: ['platform'], tagIds: ['regulatory', 'tech-debt'] }), {
        teamName: (id) => `team-${id}`,
        tagName: (id) => `tag-${id}`,
        personName: (id) => id,
        phaseName: (id) => id,
      }),
    ).toEqual(['team team-platform', 'tag tag-regulatory or tag-tech-debt']);
  });
});

/**
 * The third dimension, narrowing like the two beside it.
 *
 * Its own describe rather than cases folded into the facet block above, for the
 * reason the tag block below has one: the field is **single-valued** where every
 * other list facet is a set, so the conversion at the predicate's edge is a real
 * seam and a reader looking for "how does a scalar facet behave" should find it
 * in one place.
 *
 * Every row here states its **effective** service — the table computes the
 * inheritance before it builds these facets (`wbs-table.tsx`'s `narrowable`),
 * so a case about inheritance is a case about that build site and lives with
 * the table. What is asserted here is the predicate over the reading it is
 * handed.
 */
describe('the service facet narrows like every other facet', () => {
  const PLAN_WITH_SERVICES: NarrowableRow[] = [
    row('a', null, 'Strip the walls', { serviceIds: ['payments'] }),
    row('a1', 'a', 'Sockets', { serviceIds: ['payments'] }),
    row('a11', 'a1', 'Back boxes', { serviceIds: ['ledger'] }),
    row('a2', 'a', 'Skirting'),
    row('b', null, 'Paint', { serviceIds: ['ledger'] }),
    row('b1', 'b', 'Undercoat'),
  ];

  it('keeps the rows delivering a chosen service, and the rows that place them', () => {
    const narrowed = narrowTree(PLAN_WITH_SERVICES, asking({ serviceIds: ['ledger'] }));
    expect([...narrowed.matchIds].sort()).toEqual(['a11', 'b']);
    // `a` and `a1` are context: they place `a11` three levels down and are not
    // themselves delivering `ledger`.
    expect([...narrowed.visibleIds].sort()).toEqual(['a', 'a1', 'a11', 'b']);
  });

  it('takes two chosen services as either of them', () => {
    const narrowed = narrowTree(PLAN_WITH_SERVICES, asking({ serviceIds: ['ledger', 'payments'] }));
    expect([...narrowed.matchIds].sort()).toEqual(['a', 'a1', 'a11', 'b']);
  });

  it('leaves out a row stating no service, rather than treating empty as a match', () => {
    const narrowed = narrowTree(PLAN_WITH_SERVICES, asking({ serviceIds: ['payments'] }));
    // `a2` and `b1` state nothing. An empty set intersected with a chosen list
    // has to answer no; `carriesAnyChosen` answering "no constraint" for an
    // empty *row* set — the mirror of what it correctly answers for an empty
    // *criteria* set — is how "unstated" starts matching whichever facet is
    // asked about.
    expect(narrowed.matchIds.has('a2')).toBe(false);
    expect(narrowed.matchIds.has('b1')).toBe(false);
  });

  it('does not bring the subtree under a row that matched a service', () => {
    // Rule 3, on the newest facet: `a` matches `payments` and `a2` under it does
    // not, so a filter that seeded descendants would show a row delivering
    // nothing under a filter for a service.
    const narrowed = narrowTree(PLAN_WITH_SERVICES, asking({ serviceIds: ['payments'] }));
    expect(narrowed.visibleIds.has('a2')).toBe(false);
  });

  it('matches a row on either of the two services it delivers', () => {
    // The scope change (Dany, 2026-08-21 — "can be several services"): a row's
    // reading is a set now, so ticking one service finds a row delivering it
    // among others. Written as an equality against the chosen list, or as
    // `serviceIds[0]`, this row answers only to `payments`.
    const rows = [
      row('multi', null, 'Checkout rework', { serviceIds: ['payments', 'search'] }),
      row('single', null, 'Reindex', { serviceIds: ['search'] }),
    ];

    expect([...narrowTree(rows, asking({ serviceIds: ['payments'] })).matchIds]).toEqual(['multi']);
    expect([...narrowTree(rows, asking({ serviceIds: ['search'] })).matchIds].sort()).toEqual([
      'multi',
      'single',
    ]);
  });

  it('is independent of the team and the tag beside it', () => {
    // Three dimensions and one AND: a row answering the service and not the tag
    // is not a match, which is the property that has to survive the third
    // dimension being added.
    const rows = [
      row('x', null, 'Wiring', { serviceIds: ['payments'], tagIds: ['regulatory'] }),
      row('y', null, 'Plaster', { serviceIds: ['payments'], tagIds: [] }),
    ];
    const narrowed = narrowTree(rows, asking({ serviceIds: ['payments'], tagIds: ['regulatory'] }));
    expect([...narrowed.matchIds]).toEqual(['x']);
  });
});

/**
 * The two signals as facets: an unticked box asks nothing, a ticked one keeps
 * only the rows that answer yes.
 *
 * The booleans arrive **precomputed** on the row — `label-mismatch.ts` holds
 * the rules and `wbs-table.tsx` applies them — so what is asserted here is the
 * predicate, and nothing here is a second copy of "what counts as a mismatch".
 */
describe('the two mismatch signals narrow as flags', () => {
  const MIXED: NarrowableRow[] = [
    row('a', null, 'Strip the walls'),
    row('a1', 'a', 'Sockets', { builtByNonOwner: true }),
    row('a2', 'a', 'Skirting', { assignedOutsideTeam: true }),
    row('b', null, 'Paint', { builtByNonOwner: true, assignedOutsideTeam: true }),
  ];

  it('asks nothing while its box is unticked', () => {
    // The whole plan, and no overlay: `false` is not a filter for the rows that
    // answer false, which is the trap every boolean facet sets.
    const narrowed = narrowTree(MIXED, NO_FILTER);
    expect(narrowed.visibleIds.size).toBe(4);
    expect(narrowed.expandedOverlay).toBeNull();
  });

  it('keeps only the rows built by a non-owner', () => {
    const narrowed = narrowTree(MIXED, asking({ builtByNonOwner: true }));
    expect([...narrowed.matchIds].sort()).toEqual(['a1', 'b']);
  });

  it('keeps only the rows assigned outside the team', () => {
    const narrowed = narrowTree(MIXED, asking({ assignedOutsideTeam: true }));
    expect([...narrowed.matchIds].sort()).toEqual(['a2', 'b']);
  });

  it('takes both ticked as both, not either', () => {
    // AND across facets, which is what every other pair of ticks means here.
    // Ticking two signals to get the union would make each tick widen the
    // answer, and a filter that widens as you tick is unusable.
    const narrowed = narrowTree(
      MIXED,
      asking({ builtByNonOwner: true, assignedOutsideTeam: true }),
    );
    expect([...narrowed.matchIds]).toEqual(['b']);
  });

  it('counts as a facet, so a name beside it stops bringing the subtree', () => {
    // `isFiltering` and `anyFacetChosen` both have to know about a flag they
    // did not have before: left out of the second, ticking a signal alone would
    // seed every descendant of a match.
    expect(isFiltering(asking({ builtByNonOwner: true }))).toBe(true);
    const narrowed = narrowTree(MIXED, asking({ builtByNonOwner: true }));
    expect(narrowed.visibleIds.has('a2')).toBe(false);
  });
});

describe('what the filter says it is asking, for the third dimension', () => {
  const LABELS = {
    teamName: (id: string) => `team-${id}`,
    tagName: (id: string) => `tag-${id}`,
    serviceName: (id: string) => `service-${id}`,
    personName: (id: string) => `person-${id}`,
    phaseName: (id: string) => `phase-${id}`,
  };

  it('gives the service its own phrase beside the team and the tag', () => {
    const words = filterWords(
      asking({ teamIds: ['t1'], tagIds: ['g1'], serviceIds: ['s1', 's2'] }),
      LABELS,
    );
    // Three phrases and not one folded sentence: the dimensions are
    // independent, and a document merging them would say something neither the
    // control nor the predicate means.
    expect(words).toEqual(['team team-t1', 'tag tag-g1', 'service service-s1 or service-s2']);
  });

  it('says what each ticked signal means, rather than naming the checkbox', () => {
    const words = filterWords(asking({ builtByNonOwner: true, assignedOutsideTeam: true }), LABELS);
    expect(words).toEqual(['built by a non-owner only', 'assigned outside the team only']);
  });

  it('says nothing about a signal nobody ticked', () => {
    expect(filterWords(NO_FILTER, LABELS)).toEqual([]);
  });
});
