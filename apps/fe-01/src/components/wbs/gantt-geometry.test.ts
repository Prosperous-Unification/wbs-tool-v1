import { describe, expect, it } from 'vitest';

import {
  ASSUMED_UNESTIMATED_WORKDAYS,
  type BarColor,
  type BindingFloor,
  calendarScale,
  droppedLinkWords,
  GanttDataError,
  type GanttGeometry,
  type GanttPlan,
  type GanttRow,
  type GanttSlice,
  inkOn,
  layOutGantt,
  PERSON_BAR_COLORS,
  type PlacedArrow,
  type PlacedBar,
  type PlacedGantt,
  placeOnCalendar,
  placeOnWorkdays,
  routeArrow,
  startFloorByRow,
  type TagLabel,
  UNASSIGNED_BAR_COLOR,
} from './gantt-geometry';

/** A shown row: a leaf over these workdays, unless `extras` says otherwise. */
const rowAt = (
  id: string,
  earliestStart: number,
  earliestFinish: number,
  extras: Partial<GanttRow> = {},
): GanttRow => ({
  id,
  number: id,
  name: id,
  depth: 0,
  leaf: true,
  schedule: { earliestStart, earliestFinish },
  notBeforeOffset: null,
  priority: null,
  // One at a time, which is every row of every plan nobody has widened.
  maxParallel: 1,
  // The facts a row is enriched with before the chart is drawn. Absent by
  // default and named by the tests that are about them, so a fixture never has
  // to state a team it is not asking about.
  team: { state: 'none' },
  tags: { state: 'none' },
  trioByRole: new Map(),
  waitsFor: [],
  ...extras,
});

/**
 * A scheduled slice over these workdays, floored by the project start and
 * under the `dev` role, unless `extras` says otherwise.
 *
 * `duration` is the difference here only because these fixtures are whole
 * days end to end; the one test about a fraction passes its own.
 */
const sliceAt = (
  id: string,
  workItemId: string,
  earliestStart: number,
  earliestFinish: number,
  extras: Partial<GanttSlice> = {},
): GanttSlice => ({
  id,
  workItemId,
  roleId: 'dev',
  personId: null,
  duration: earliestFinish - earliestStart,
  estimated: true,
  earliestStart,
  earliestFinish,
  float: 0,
  critical: false,
  boundBy: 'projectStart',
  resourcePredecessorId: null,
  // Width 1 is the plan nobody has sized: effort is the duration, and no pool
  // held anything up. The capacity fixtures below pass their own three.
  width: 1,
  effort: earliestFinish - earliestStart,
  capacityPredecessorIds: [],
  ...extras,
});

/**
 * The full tree a fixture's shown rows imply: each row's parent is the nearest
 * shallower row above it. The tests about a **hidden** branch pass their own
 * `tree`, because hidden rows are exactly what shown rows cannot imply.
 */
const treeFrom = (rows: readonly GanttRow[]): { id: string; parentId: string | null }[] => {
  const above: { id: string; depth: number }[] = [];
  return rows.map((row) => {
    while (above.length > 0 && above[above.length - 1].depth >= row.depth) above.pop();
    const parentId = above.length > 0 ? above[above.length - 1].id : null;
    above.push({ id: row.id, depth: row.depth });
    return { id: row.id, parentId };
  });
};

/** A plan with two roles and one person, over the rows and slices given. */
const planOf = (parts: Partial<GanttPlan>): GanttPlan => ({
  rows: [],
  slices: [],
  dependencies: [],
  tree: treeFrom(parts.rows ?? []),
  // Off unless a test is about the sentence a filter's dropped waits earn.
  narrowedByFilter: false,
  roles: [
    { id: 'dev', name: 'Dev' },
    { id: 'qa', name: 'QA' },
  ],
  personNames: new Map([['kat', 'Kat']]),
  ...parts,
});

describe('bars', () => {
  it('draws one per slice of a leaf, in role order', () => {
    const chart = layOutGantt(
      planOf({
        rows: [rowAt('strip', 0, 5)],
        // Fed out of role order on purpose: the order bars sit in is the
        // plan's role order, not the payload's array order.
        slices: [
          sliceAt('strip-qa', 'strip', 3, 5, { roleId: 'qa' }),
          sliceAt('strip-dev', 'strip', 0, 3),
        ],
      }),
    );

    expect(chart.bars.map((bar) => bar.sliceId)).toEqual(['strip-dev', 'strip-qa']);
    expect(chart.bars.map((bar) => [bar.start, bar.finish, bar.duration])).toEqual([
      [0, 3, 3],
      [3, 5, 2],
    ]);
    expect(chart.bars.every((bar) => bar.rowIndex === 0)).toBe(true);
  });

  it('passes engine numbers through verbatim, fractions and all', () => {
    const start = 3.6666666666666665;
    const finish = 6.333333333333333;
    const chart = layOutGantt(
      planOf({
        rows: [rowAt('sand', start, finish)],
        slices: [sliceAt('sand-dev', 'sand', start, finish, { duration: 2.6666666666666665 })],
      }),
    );

    const [bar] = chart.bars;
    expect(bar.start).toBe(3.6666666666666665);
    expect(bar.finish).toBe(6.333333333333333);
    expect(bar.duration).toBe(2.6666666666666665);
    expect(chart.horizon).toBe(6.333333333333333);
  });

  it('carries the critical path and the unestimated slice as facts of their own', () => {
    const chart = layOutGantt(
      planOf({
        rows: [rowAt('strip', 0, 3), rowAt('sand', 0, 2)],
        slices: [
          sliceAt('strip-dev', 'strip', 0, 3, { critical: true }),
          sliceAt('sand-dev', 'sand', 0, 2, { estimated: false }),
        ],
      }),
    );

    expect(chart.bars.map((bar) => [bar.critical, bar.estimated])).toEqual([
      [true, true],
      [false, false],
    ]);
  });

  it('skips a slice whose row is not shown', () => {
    const chart = layOutGantt(
      planOf({
        rows: [rowAt('strip', 0, 3)],
        slices: [sliceAt('strip-dev', 'strip', 0, 3), sliceAt('hidden-dev', 'hidden', 0, 9)],
      }),
    );

    expect(chart.bars.map((bar) => bar.sliceId)).toEqual(['strip-dev']);
  });

  it('says in words what a start is held by', () => {
    const chart = layOutGantt(
      planOf({
        rows: [rowAt('a', 0, 1), rowAt('b', 1, 2), rowAt('c', 2, 3), rowAt('d', 3, 4)],
        slices: [
          sliceAt('a-dev', 'a', 0, 1),
          sliceAt('b-dev', 'b', 1, 2, { boundBy: 'predecessor' }),
          sliceAt('c-dev', 'c', 2, 3, { boundBy: 'roleOrder' }),
          sliceAt('d-dev', 'd', 3, 4, { boundBy: 'notBefore' }),
        ],
      }),
    );

    expect(chart.bars.map((bar) => bar.floorWords)).toEqual([
      'Starts with the project',
      'Waits for a dependency’s first estimated role',
      'Waits for an earlier role on this item',
      'Held by its start-no-earlier-than date',
    ]);
  });

  it('says why a not-before is there, where somebody has written it down', () => {
    // *"blocked until the 12th, waiting on client sign-off"* — the sentence this
    // change exists to make sayable, and the whole of what it adds to the chart.
    // Appended to the floor sentence rather than replacing it: the date is still
    // what holds the bar, and the words are an aside on a floor that reads
    // identically without them.
    //
    // The em-dash is the person and capacity floors' own shape, so a reader
    // moving between bars does not have to notice which kind they are hovering.
    const chart = layOutGantt(
      planOf({
        rows: [rowAt('sand', 3, 4, { notBeforeReason: 'waiting on client sign-off' })],
        slices: [sliceAt('sand-dev', 'sand', 3, 4, { boundBy: 'notBefore' })],
      }),
    );

    expect(chart.bars[0].floorWords).toBe(
      'Held by its start-no-earlier-than date — waiting on client sign-off',
    );
  });

  it('says only the floor for a not-before nobody has explained', () => {
    // Every dated row in every plan today, and every one nobody bothers to
    // explain tomorrow. A reason is an optional aside, so its absence has to
    // read exactly as this bar read before the column existed — not as an empty
    // dash and not as the word `null`.
    const chart = layOutGantt(
      planOf({
        rows: [rowAt('sand', 3, 4, { notBeforeReason: null })],
        slices: [sliceAt('sand-dev', 'sand', 3, 4, { boundBy: 'notBefore' })],
      }),
    );

    expect(chart.bars[0].floorWords).toBe('Held by its start-no-earlier-than date');
  });

  it('leaves the words off a bar something else is holding', () => {
    // The row's date is set and explained, and a dependency is what actually
    // binds this bar. The reason belongs to the floor, not to the row: a
    // sentence about a not-before printed on a bar that is waiting for a
    // predecessor would be the chart naming one cause and explaining another.
    //
    // Proof: the reason appended to the shared `projectStart`/`predecessor`/
    // `roleOrder` arm as well — **1 failed, 103 passed** — and this failed on
    // `expected 'Waits for a dependency’s first estimated role — waiting on
    // client sign-off' to be 'Waits for a dependency’s first estimated role'`.
    // Watched 2026-08-18.
    const chart = layOutGantt(
      planOf({
        rows: [
          rowAt('strip', 0, 3),
          rowAt('sand', 3, 4, {
            notBeforeOffset: 1,
            notBeforeReason: 'waiting on client sign-off',
          }),
        ],
        slices: [
          sliceAt('strip-dev', 'strip', 0, 3),
          sliceAt('sand-dev', 'sand', 3, 4, { boundBy: 'predecessor' }),
        ],
      }),
    );

    expect(chart.bars[1].floorWords).toBe('Waits for a dependency’s first estimated role');
  });

  it('says the same words on every bar of a row the not-before holds', () => {
    // The reason is the **row's**, and a work item's not-before holds every one
    // of its roles — so a row estimated for two phases draws two bars and both
    // are floored by the same date for the same reason. One sentence, said
    // wherever it is true.
    const chart = layOutGantt(
      planOf({
        rows: [rowAt('sand', 3, 5, { notBeforeReason: 'waiting on client sign-off' })],
        slices: [
          sliceAt('sand-dev', 'sand', 3, 4, { boundBy: 'notBefore' }),
          sliceAt('sand-qa', 'sand', 3, 5, { boundBy: 'notBefore', roleId: 'qa' }),
        ],
      }),
    );

    expect(chart.bars.map((bar) => bar.floorWords)).toEqual([
      'Held by its start-no-earlier-than date — waiting on client sign-off',
      'Held by its start-no-earlier-than date — waiting on client sign-off',
    ]);
  });
});

describe('summary brackets', () => {
  /** A parent whose two children run 0→3 and 2→6: a 6-day branch of 7 days' work. */
  const staggeredChildren = (): GanttPlan =>
    planOf({
      rows: [
        rowAt('phase', 0, 6, { leaf: false }),
        rowAt('strip', 0, 3, { depth: 1 }),
        rowAt('sand', 2, 6, { depth: 1 }),
      ],
      slices: [sliceAt('strip-dev', 'strip', 0, 3), sliceAt('sand-dev', 'sand', 2, 6)],
    });

  it('spans a parent over staggered children', () => {
    const chart = layOutGantt(staggeredChildren());

    expect(chart.brackets).toEqual([{ rowId: 'phase', rowIndex: 0, start: 0, finish: 6 }]);
    expect(chart.bars.map((bar) => bar.rowIndex)).toEqual([1, 2]);
  });

  it('is a span and not the sum of what is under it', () => {
    const chart = layOutGantt(staggeredChildren());

    // 3 + 4 is the effort in the branch; 6 is the branch. A bracket that summed
    // would finish at 7 and claim a day the plan does not take.
    expect(chart.brackets[0].finish).not.toBe(7);
    expect(chart.brackets[0].finish).toBe(6);
    expect(chart.horizon).toBe(6);
  });

  it('draws no bracket for a leaf and no bar for a parent', () => {
    const chart = layOutGantt(staggeredChildren());

    expect(chart.brackets.map((bracket) => bracket.rowId)).toEqual(['phase']);
    expect(chart.bars.map((bar) => bar.sliceId)).toEqual(['strip-dev', 'sand-dev']);
  });
});

describe('person links', () => {
  /** Kat finishes `Strip` (Dev) and only then starts `Sand` — no dependency between them. */
  const handOff = (parts: Partial<GanttPlan> = {}): GanttPlan =>
    planOf({
      rows: [rowAt('strip', 0, 3), rowAt('sand', 3, 5)],
      slices: [
        sliceAt('strip-dev', 'strip', 0, 3, { personId: 'kat' }),
        sliceAt('sand-dev', 'sand', 3, 5, {
          personId: 'kat',
          boundBy: 'person',
          resourcePredecessorId: 'strip-dev',
        }),
      ],
      ...parts,
    });

  it('draws a hand-off, and no dependency arrow with it', () => {
    const chart = layOutGantt(handOff());

    expect(chart.personLinks).toEqual([
      {
        fromSliceId: 'strip-dev',
        fromRowIndex: 0,
        fromStart: 0,
        fromFinish: 3,
        toSliceId: 'sand-dev',
        toRowIndex: 1,
        toStart: 3,
        personColor: PERSON_BAR_COLORS[0],
      },
    ]);
    expect(chart.arrows).toEqual([]);
  });

  /**
   * The link and the two bars are three readings of one hand-off, and this is
   * the test that says they cannot disagree: the line leaves where the busy bar
   * ends and arrives where the waiting bar begins, on the rows those bars are
   * on, in the colour they are painted.
   */
  it('leaves and arrives exactly where the two bars are, in their colour', () => {
    const chart = layOutGantt(handOff());
    const [busy, waiting] = chart.bars;
    const [link] = chart.personLinks;

    expect([link.fromRowIndex, link.fromFinish]).toEqual([busy.rowIndex, busy.finish]);
    expect([link.toRowIndex, link.toStart]).toEqual([waiting.rowIndex, waiting.start]);
    expect(link.personColor).toBe(busy.personColor);
    expect(link.personColor).toBe(waiting.personColor);
    // And the hand-off is what the second bar's start *is*: Kat's queue, not a
    // dependency, put it at 3 — the same 3 the first bar finishes at.
    expect(waiting.start).toBe(busy.finish);
  });

  it('draws a hand-off, not an arrow, when the person is the later floor', () => {
    // `Sand` depends on `Trim`, which finishes at 1 — but Kat is on `Strip`
    // until 3, so the person is the binding floor and the arrow is drawn as
    // well because the dependency is stored. Two marks, saying two things.
    const chart = layOutGantt(
      handOff({
        rows: [rowAt('trim', 0, 1), rowAt('strip', 0, 3), rowAt('sand', 3, 5)],
        slices: [
          sliceAt('trim-dev', 'trim', 0, 1),
          sliceAt('strip-dev', 'strip', 0, 3, { personId: 'kat' }),
          sliceAt('sand-dev', 'sand', 3, 5, {
            personId: 'kat',
            boundBy: 'person',
            resourcePredecessorId: 'strip-dev',
          }),
        ],
        dependencies: [{ predecessorId: 'trim', successorId: 'sand' }],
      }),
    );

    expect(chart.personLinks.map((link) => [link.fromSliceId, link.toStart])).toEqual([
      ['strip-dev', 3],
    ]);
    // The arrow leaves the dependency's own finish, 1, and lands on the start
    // the person set, 3 — the gap between them being exactly what a reader is
    // looking at the chart to see.
    expect(chart.arrows.map((arrow) => [arrow.fromFinish, arrow.toStart])).toEqual([[1, 3]]);
  });

  it('draws no hand-off where the dependency is the later floor', () => {
    // The same two people-slices, but `Sand` waits on `Trim` until 4: the
    // dependency is later than Kat's finish, so `boundBy` is the predecessor
    // and no person link is drawn at all. A tie is never the person.
    const chart = layOutGantt(
      handOff({
        rows: [rowAt('trim', 0, 4), rowAt('strip', 0, 3), rowAt('sand', 4, 6)],
        slices: [
          sliceAt('trim-dev', 'trim', 0, 4),
          sliceAt('strip-dev', 'strip', 0, 3, { personId: 'kat' }),
          sliceAt('sand-dev', 'sand', 4, 6, {
            personId: 'kat',
            boundBy: 'predecessor',
            resourcePredecessorId: 'strip-dev',
          }),
        ],
        dependencies: [{ predecessorId: 'trim', successorId: 'sand' }],
      }),
    );

    expect(chart.personLinks).toEqual([]);
    expect(chart.arrows.map((arrow) => [arrow.fromFinish, arrow.toStart])).toEqual([[4, 4]]);
    expect(chart.bars[2].floorWords).toBe('Waits for a dependency’s first estimated role');
  });

  it('names the person and the slice they were finishing', () => {
    const chart = layOutGantt(handOff());

    expect(chart.bars[1].floorWords).toBe('Kat — after strip (Dev)');
  });

  it('skips the link when the row it comes from is not shown, and says so on the bar', () => {
    const chart = layOutGantt(handOff({ rows: [rowAt('sand', 3, 5)] }));

    expect(chart.personLinks).toEqual([]);
    expect(chart.bars.map((bar) => bar.sliceId)).toEqual(['sand-dev']);
    expect(chart.bars[0].floorWords).toBe('Kat — after work that is not shown');
  });

  it('throws when a resource predecessor names no slice in the payload', () => {
    const dangling = handOff({
      slices: [
        sliceAt('strip-dev', 'strip', 0, 3, { personId: 'kat' }),
        sliceAt('sand-dev', 'sand', 3, 5, {
          personId: 'kat',
          boundBy: 'person',
          resourcePredecessorId: 'a-slice-that-left',
        }),
      ],
    });

    expect(() => layOutGantt(dangling)).toThrow(GanttDataError);
    expect(() => layOutGantt(dangling)).toThrow('a-slice-that-left');
  });

  it('throws on a dangling resource predecessor even where no bar would be drawn', () => {
    const dangling = handOff({
      rows: [rowAt('strip', 0, 3)],
      slices: [
        sliceAt('strip-dev', 'strip', 0, 3, { personId: 'kat' }),
        sliceAt('sand-dev', 'sand', 3, 5, {
          personId: 'kat',
          boundBy: 'person',
          resourcePredecessorId: 'a-slice-that-left',
        }),
      ],
    });

    expect(() => layOutGantt(dangling)).toThrow(GanttDataError);
  });

  it('throws when a person floor names no resource predecessor', () => {
    const nobodyToWaitFor = handOff({
      slices: [
        sliceAt('strip-dev', 'strip', 0, 3, { personId: 'kat' }),
        sliceAt('sand-dev', 'sand', 3, 5, { personId: 'kat', boundBy: 'person' }),
      ],
    });

    expect(() => layOutGantt(nobodyToWaitFor)).toThrow(GanttDataError);
    expect(() => layOutGantt(nobodyToWaitFor)).toThrow('names no resource predecessor');
  });

  it('throws when a person floor names somebody the plan does not', () => {
    const stranger = handOff({ personNames: new Map([['someone-else', 'Sam']]) });

    expect(() => layOutGantt(stranger)).toThrow(GanttDataError);
    expect(() => layOutGantt(stranger)).toThrow('does not name');
  });
});

/**
 * A bar whose date came from its team having nobody spare.
 *
 * Two slices on one pool: `strip` holds Platform's slots until day 3, and
 * `sand` — which needs three of them — cannot start until it lets go. The
 * blocking set is what be-01 sends; `resourcePredecessorId` is its display
 * referent, be-01's own pick of the latest finisher out of it.
 */
describe('a bar held by a team’s capacity', () => {
  const pooled = (parts: Partial<GanttPlan> = {}): GanttPlan =>
    planOf({
      rows: [
        rowAt('strip', 0, 3, { team: { state: 'named', name: 'Platform' } }),
        rowAt('sand', 3, 5, { team: { state: 'named', name: 'Platform' } }),
      ],
      slices: [
        sliceAt('strip-dev', 'strip', 0, 3),
        sliceAt('sand-dev', 'sand', 3, 5, {
          boundBy: 'capacity',
          resourcePredecessorId: 'strip-dev',
          capacityPredecessorIds: ['strip-dev'],
          width: 3,
          effort: 6,
          duration: 2,
        }),
      ],
      ...parts,
    });

  const wordsFor = (chart: ReturnType<typeof layOutGantt>, sliceId: string): string =>
    chart.bars.find((bar) => bar.sliceId === sliceId)?.floorWords ?? '';

  it('names the team, how many people it needs, and what freeing them let it start', () => {
    const chart = layOutGantt(pooled());

    expect(wordsFor(chart, 'sand-dev')).toBe(
      'Waits for Platform to free 3 people — after strip (Dev)',
    );
  });

  it('says “a person” for a slice that needs one slot, not “1 people”', () => {
    const chart = layOutGantt(
      pooled({
        slices: [
          sliceAt('strip-dev', 'strip', 0, 3),
          sliceAt('sand-dev', 'sand', 3, 5, {
            boundBy: 'capacity',
            resourcePredecessorId: 'strip-dev',
            capacityPredecessorIds: ['strip-dev'],
          }),
        ],
      }),
    );

    expect(wordsFor(chart, 'sand-dev')).toBe(
      'Waits for Platform to free a person — after strip (Dev)',
    );
  });

  /**
   * The whole blocking set is carried and only one of it is named.
   *
   * D8's reading on screen: the wait is disjunctive — at least one of these had
   * to move — so naming the referent and counting the rest is the only sentence
   * that is true. A card listing all of them is a card nobody reads to the end.
   */
  it('counts the rest of the blocking set rather than naming every one of it', () => {
    const chart = layOutGantt(
      pooled({
        rows: [
          rowAt('strip', 0, 3, { team: { state: 'named', name: 'Platform' } }),
          rowAt('sand', 0, 2, { team: { state: 'named', name: 'Platform' } }),
          rowAt('wax', 3, 5, { team: { state: 'named', name: 'Platform' } }),
        ],
        slices: [
          sliceAt('strip-dev', 'strip', 0, 3),
          sliceAt('sand-dev', 'sand', 0, 2),
          sliceAt('wax-dev', 'wax', 3, 5, {
            boundBy: 'capacity',
            resourcePredecessorId: 'strip-dev',
            capacityPredecessorIds: ['strip-dev', 'sand-dev'],
            width: 2,
            effort: 4,
            duration: 2,
          }),
        ],
      }),
    );

    // Proof: `and ${n} other${n === 1 ? '' : 's'}` replaced by the bare
    // `and ${n} others` this shipped with, watched failing on `expected
    // '… and 1 others' to be '… and 1 other'` on 2026-08-14. A set of exactly
    // two is the commonest non-trivial case, so this string is the one most
    // readers meet.
    expect(wordsFor(chart, 'wax-dev')).toBe(
      'Waits for Platform to free 2 people — after strip (Dev) and 1 other',
    );
  });

  /**
   * The plural arm, so the singular fix cannot be "always say other".
   *
   * Without this case, `and ${n} other` with the `s` dropped altogether passes
   * the test above and ships a second copy defect in the fix for the first.
   */
  it('keeps the plural where more than one other bar was holding the pool', () => {
    const chart = layOutGantt(
      pooled({
        rows: [
          rowAt('strip', 0, 3, { team: { state: 'named', name: 'Platform' } }),
          rowAt('sand', 0, 2, { team: { state: 'named', name: 'Platform' } }),
          rowAt('rinse', 0, 2, { team: { state: 'named', name: 'Platform' } }),
          rowAt('wax', 3, 5, { team: { state: 'named', name: 'Platform' } }),
        ],
        slices: [
          sliceAt('strip-dev', 'strip', 0, 3),
          sliceAt('sand-dev', 'sand', 0, 2),
          sliceAt('rinse-dev', 'rinse', 0, 2),
          sliceAt('wax-dev', 'wax', 3, 5, {
            boundBy: 'capacity',
            resourcePredecessorId: 'strip-dev',
            capacityPredecessorIds: ['strip-dev', 'sand-dev', 'rinse-dev'],
            width: 2,
            effort: 4,
            duration: 2,
          }),
        ],
      }),
    );

    // Proof: the `s` dropped from the plural arm — `and ${n} other` for every
    // count — watched failing on `expected '… and 2 other' to be '… and 2
    // others'` on 2026-08-14.
    expect(wordsFor(chart, 'wax-dev')).toBe(
      'Waits for Platform to free 2 people — after strip (Dev) and 2 others',
    );
  });

  it('says so where the freeing row is not on screen at all', () => {
    const chart = layOutGantt(
      pooled({
        // `strip`'s row is gone — collapsed away or narrowed off by a search —
        // while its slice is still in the payload, which is the state a hidden
        // predecessor leaves behind.
        rows: [rowAt('sand', 3, 5, { team: { state: 'named', name: 'Platform' } })],
      }),
    );

    expect(wordsFor(chart, 'sand-dev')).toBe(
      'Waits for Platform to free 3 people — after work that is not shown',
    );
  });

  it('reads an inherited label as the pool, because that is what be-01 scheduled on', () => {
    const chart = layOutGantt(
      pooled({
        rows: [
          rowAt('strip', 0, 3, { team: { state: 'named', name: 'Platform' } }),
          rowAt('sand', 3, 5, {
            team: { state: 'inherited', name: 'Platform', fromRow: '010 Backend' },
          }),
        ],
      }),
    );

    expect(wordsFor(chart, 'sand-dev')).toBe(
      'Waits for Platform to free 3 people — after strip (Dev)',
    );
  });

  it('draws one pool wait, from the display referent to the bar that waited', () => {
    const chart = layOutGantt(pooled());

    expect(chart.capacityLinks).toEqual([
      {
        fromSliceId: 'strip-dev',
        fromRowIndex: 0,
        fromStart: 0,
        fromFinish: 3,
        toSliceId: 'sand-dev',
        toRowIndex: 1,
        toStart: 3,
      },
    ]);
    // Not a hand-off: nobody is named on either slice, and a pool wait drawn as
    // a person link would tell the reader to go and talk to somebody.
    expect(chart.personLinks).toEqual([]);
  });

  it('draws no pool wait to a slice whose row is not on the chart', () => {
    const chart = layOutGantt(
      pooled({ rows: [rowAt('sand', 3, 5, { team: { state: 'named', name: 'Platform' } })] }),
    );

    expect(chart.capacityLinks).toEqual([]);
  });

  it('throws when a capacity floor names no display referent', () => {
    const nothingToWaitFor = pooled({
      slices: [
        sliceAt('strip-dev', 'strip', 0, 3),
        sliceAt('sand-dev', 'sand', 3, 5, {
          boundBy: 'capacity',
          capacityPredecessorIds: ['strip-dev'],
          width: 3,
        }),
      ],
    });

    expect(() => layOutGantt(nothingToWaitFor)).toThrow(GanttDataError);
    expect(() => layOutGantt(nothingToWaitFor)).toThrow('names no display referent');
  });

  /**
   * The invariant `capacity-engine` holds on its own side, asserted here on the
   * production read path — which is where a malformed payload actually arrives.
   */
  it('throws when a capacity floor says nothing was holding the pool', () => {
    const heldByNothing = pooled({
      slices: [
        sliceAt('strip-dev', 'strip', 0, 3),
        sliceAt('sand-dev', 'sand', 3, 5, {
          boundBy: 'capacity',
          resourcePredecessorId: 'strip-dev',
          capacityPredecessorIds: [],
          width: 3,
        }),
      ],
    });

    expect(() => layOutGantt(heldByNothing)).toThrow(GanttDataError);
    expect(() => layOutGantt(heldByNothing)).toThrow('nothing was holding the pool');
  });

  it('throws when a capacity-floored row names no team to be short of', () => {
    const noPool = pooled({
      rows: [rowAt('strip', 0, 3), rowAt('sand', 3, 5)],
    });

    expect(() => layOutGantt(noPool)).toThrow(GanttDataError);
    expect(() => layOutGantt(noPool)).toThrow('names no team');
  });

  /**
   * The one state above that is a **skew** and not a broken payload, so the
   * sentence degrades instead of the chart being thrown away.
   *
   * `unresolved` is what {@link ServiceTeamLabel} documents as normal — the
   * label rides the tree read and the names ride the directory read, and a team
   * created between the two is a stale lookup. The cards say
   * `a team this plan has not loaded` for it, the export says `(unknown)`, and
   * before this arm the chart said nothing at all because it threw.
   */
  it('carries words for a team the directory read has not caught up with', () => {
    const staleLookup = pooled({
      rows: [
        rowAt('strip', 0, 3, { team: { state: 'named', name: 'Platform' } }),
        rowAt('sand', 3, 5, { team: { state: 'unresolved' } }),
      ],
    });

    expect(wordsFor(layOutGantt(staleLookup), 'sand-dev')).toBe(
      'Waits for a team this plan has not loaded to free 3 people — after strip (Dev)',
    );
  });
});

/**
 * A floor this module has no words for.
 *
 * `boundBy` is a wire value, and the union says six because that is what be-01
 * sends today. A seventh added there — a resource calendar, a fixed date —
 * arrives here as a string, and the cast is how a test says "the payload
 * carried a value this build has never heard of" without waiting for be-01 to
 * grow one. That is the boundary that makes it safe: nothing else in this file
 * casts, and this one exists to reach the branch a type cannot.
 *
 * It said `resourceCalendar` until this change and that was a **seventh** name
 * nobody sends; the sixth be-01 had been sending since `capacity-engine` was
 * `capacity`, and this file could not say the word (the C2 cross-review's P3-1).
 * The unknown one is now plainly invented, and `capacity` has tests of its own
 * above.
 */
describe('a binding floor this build does not know', () => {
  const heldByTheUnknown = (): GanttPlan =>
    planOf({
      rows: [rowAt('strip', 0, 3)],
      slices: [
        sliceAt('strip-dev', 'strip', 0, 3, {
          boundBy: 'phaseOfTheMoon' as BindingFloor,
        }),
      ],
    });

  it('throws rather than saying nothing at all about what holds a bar', () => {
    // Proof: the `default` branch replaced by the index it used to be —
    // `FLOOR_SENTENCE[slice.boundBy as Exclude<BindingFloor, 'person'>]`. This
    // test alone failed, on `expected function to throw an error, but it
    // didn't`; the same run printed what shipped instead — `floorWords`
    // `undefined`, and the bar's hover title ending `…Float 0 days\n` with
    // nothing after the newline. Watched 2026-08-09.
    expect(() => layOutGantt(heldByTheUnknown())).toThrow(GanttDataError);
    expect(() => layOutGantt(heldByTheUnknown())).toThrow('phaseOfTheMoon');
  });
});

describe('dependency arrows', () => {
  const twoRowsOneEdge = (parts: Partial<GanttPlan> = {}): GanttPlan =>
    planOf({
      rows: [rowAt('strip', 0, 3), rowAt('sand', 3, 5)],
      slices: [sliceAt('strip-dev', 'strip', 0, 3), sliceAt('sand-dev', 'sand', 3, 5)],
      dependencies: [{ predecessorId: 'strip', successorId: 'sand' }],
      ...parts,
    });

  it('joins a predecessor finish to a successor start', () => {
    const chart = layOutGantt(twoRowsOneEdge());

    expect(chart.arrows).toEqual([
      {
        predecessorId: 'strip',
        successorId: 'sand',
        fromRowIndex: 0,
        fromStart: 0,
        fromFinish: 3,
        toRowIndex: 1,
        toStart: 3,
      },
    ]);
    expect(chart.personLinks).toEqual([]);
  });

  /**
   * Two predecessors, one successor: the join a Gantt is read for.
   *
   * One arrow per **stored** edge and not one from the latest predecessor
   * alone — the chart draws what was written down, and which of the two set the
   * start is the bar's own binding floor to say. Both arrows land on the same
   * start, which is the max of the two finishes.
   */
  it('joins every stored predecessor to the same successor start', () => {
    const chart = layOutGantt(
      planOf({
        rows: [rowAt('strip', 0, 3), rowAt('trim', 0, 5), rowAt('sand', 5, 7)],
        slices: [
          sliceAt('strip-dev', 'strip', 0, 3),
          sliceAt('trim-dev', 'trim', 0, 5),
          sliceAt('sand-dev', 'sand', 5, 7, { boundBy: 'predecessor' }),
        ],
        dependencies: [
          { predecessorId: 'strip', successorId: 'sand' },
          { predecessorId: 'trim', successorId: 'sand' },
        ],
      }),
    );

    expect(
      chart.arrows.map((arrow) => [arrow.predecessorId, arrow.fromFinish, arrow.toStart]),
    ).toEqual([
      ['strip', 3, 5],
      ['trim', 5, 5],
    ]);
    // The successor starts at the later of the two finishes, and the arrow from
    // the earlier one is the slack drawn: 3 → 5 with nothing in between.
    expect(chart.bars[2].start).toBe(5);
  });

  it('skips an arrow whose end is not shown', () => {
    const chart = layOutGantt(
      twoRowsOneEdge({
        rows: [rowAt('sand', 3, 5)],
        slices: [sliceAt('sand-dev', 'sand', 3, 5)],
      }),
    );

    expect(chart.arrows).toEqual([]);
    expect(chart.bars.map((bar) => bar.sliceId)).toEqual(['sand-dev']);
  });

  it('the arrow does not overshoot a parallel successor', () => {
    // `sand` waits on `strip`'s anchor — its Dev, done on day 3 — while
    // `strip`'s QA runs 3→5 beside it. An arrow from the projection finish at
    // 5 would point backwards past the start it lands on.
    const chart = layOutGantt(
      planOf({
        rows: [rowAt('strip', 0, 5), rowAt('sand', 3, 6)],
        slices: [
          sliceAt('strip-dev', 'strip', 0, 3),
          sliceAt('strip-qa', 'strip', 3, 5, { roleId: 'qa' }),
          sliceAt('sand-dev', 'sand', 3, 6, { boundBy: 'predecessor' }),
        ],
        dependencies: [{ predecessorId: 'strip', successorId: 'sand' }],
      }),
    );

    expect(chart.arrows).toEqual([
      {
        predecessorId: 'strip',
        successorId: 'sand',
        fromRowIndex: 0,
        fromStart: 0,
        fromFinish: 3,
        toRowIndex: 1,
        toStart: 3,
      },
    ]);
  });

  it('an arrow from a branch leaves its latest anchor', () => {
    // `rig` depends on the parent: every leaf's first-role work must be done,
    // and `sand`'s Dev is the later of them at day 4 — `strip`'s at 2, both
    // QAs running on to 5. The arrow leaves day 4, from the parent's own
    // bracket row.
    const chart = layOutGantt(
      planOf({
        rows: [
          rowAt('hull', 0, 5, { leaf: false }),
          rowAt('strip', 0, 5, { depth: 1 }),
          rowAt('sand', 0, 5, { depth: 1 }),
          rowAt('rig', 4, 6),
        ],
        slices: [
          sliceAt('strip-dev', 'strip', 0, 2),
          sliceAt('strip-qa', 'strip', 2, 5, { roleId: 'qa' }),
          sliceAt('sand-dev', 'sand', 0, 4),
          sliceAt('sand-qa', 'sand', 4, 5, { roleId: 'qa' }),
          sliceAt('rig-dev', 'rig', 4, 6, { boundBy: 'predecessor' }),
        ],
        dependencies: [{ predecessorId: 'hull', successorId: 'rig' }],
      }),
    );

    expect(chart.arrows).toEqual([
      {
        predecessorId: 'hull',
        successorId: 'rig',
        fromRowIndex: 0,
        fromStart: 0,
        fromFinish: 4,
        toRowIndex: 3,
        toStart: 4,
      },
    ]);
  });

  it('anchors a collapsed branch through the full tree, not the shown rows', () => {
    // The same branch with its leaves collapsed away: their rows are gone from
    // `rows`, their slices are still in the payload, and the tree is what
    // still says whose they are. The arrow must leave the same day 4.
    const chart = layOutGantt(
      planOf({
        rows: [rowAt('hull', 0, 5, { leaf: false }), rowAt('rig', 4, 6)],
        slices: [
          sliceAt('strip-dev', 'strip', 0, 2),
          sliceAt('strip-qa', 'strip', 2, 5, { roleId: 'qa' }),
          sliceAt('sand-dev', 'sand', 0, 4),
          sliceAt('sand-qa', 'sand', 4, 5, { roleId: 'qa' }),
          sliceAt('rig-dev', 'rig', 4, 6, { boundBy: 'predecessor' }),
        ],
        tree: [
          { id: 'hull', parentId: null },
          { id: 'strip', parentId: 'hull' },
          { id: 'sand', parentId: 'hull' },
          { id: 'rig', parentId: null },
        ],
        dependencies: [{ predecessorId: 'hull', successorId: 'rig' }],
      }),
    );

    // The hidden leaves draw no bars — that rule is untouched.
    expect(chart.bars.map((bar) => bar.sliceId)).toEqual(['rig-dev']);
    expect(chart.arrows).toEqual([
      {
        predecessorId: 'hull',
        successorId: 'rig',
        fromRowIndex: 0,
        fromStart: 0,
        fromFinish: 4,
        toRowIndex: 1,
        toStart: 4,
      },
    ]);
  });

  it('anchors a parent of parents through the leaves two levels down', () => {
    // `hull` holds `deck`, and only `deck` holds the leaves `strip` and
    // `sand` — plus `keel` directly under `hull`. `rig` depends on `hull`, so
    // the anchor is the latest-finishing first-role work among the leaf
    // descendants at **any** depth: `keel`'s Dev ends day 1, `strip`'s day 2,
    // `sand`'s day 4 — the arrow leaves day 4, from `hull`'s bracket row. A
    // walk that stopped at `hull`'s direct children would take `deck` for a
    // leaf and find it has no slice.
    //
    // Proof: `leavesUnder`'s recursion shallowed to direct children —
    // `children.map((child) => child.id)` in place of the `flatMap` over
    // `walk` — and this failed alone, `1 failed | 67 passed`, on
    // `GanttDataError: dependency hull → rig: deck has no slice in this
    // payload`; watched 2026-08-11.
    const chart = layOutGantt(
      planOf({
        rows: [
          rowAt('hull', 0, 6, { leaf: false }),
          rowAt('deck', 0, 6, { depth: 1, leaf: false }),
          rowAt('strip', 0, 5, { depth: 2 }),
          rowAt('sand', 0, 6, { depth: 2 }),
          rowAt('keel', 0, 3, { depth: 1 }),
          rowAt('rig', 4, 6),
        ],
        slices: [
          sliceAt('strip-dev', 'strip', 0, 2),
          sliceAt('strip-qa', 'strip', 2, 5, { roleId: 'qa' }),
          sliceAt('sand-dev', 'sand', 0, 4),
          sliceAt('sand-qa', 'sand', 4, 6, { roleId: 'qa' }),
          sliceAt('keel-dev', 'keel', 0, 1),
          sliceAt('keel-qa', 'keel', 1, 3, { roleId: 'qa' }),
          sliceAt('rig-dev', 'rig', 4, 6, { boundBy: 'predecessor' }),
        ],
        dependencies: [{ predecessorId: 'hull', successorId: 'rig' }],
      }),
    );

    expect(chart.arrows).toEqual([
      {
        predecessorId: 'hull',
        successorId: 'rig',
        fromRowIndex: 0,
        fromStart: 0,
        fromFinish: 4,
        toRowIndex: 5,
        toStart: 4,
      },
    ]);
  });

  it('an arrow leaves the first estimated role, not the unestimated one in front of it', () => {
    // The engine's own probe, drawn: `strip`'s Dev carries no estimate, so the
    // anchor walks on to its QA — 5→9 — and the arrow leaves day 9, which is
    // where `sand` starts. An arrow from the unestimated Dev would leave day 5
    // and point at a bar four days to its right with nothing between them,
    // claiming a wait the engine did not impose.
    //
    // Proof: the selection reverted to `own.at(0)` — the first slice plain,
    // which is what this file did before the walk — and this alone failed,
    // `1 failed | 68 passed`, on `expected { predecessorId: 'strip', …(6) } to
    // match object { fromStart: 5, fromFinish: 9, …(1) }`; watched 2026-08-11.
    const chart = layOutGantt(
      planOf({
        rows: [rowAt('strip', 5, 9), rowAt('sand', 9, 11)],
        slices: [
          sliceAt('strip-dev', 'strip', 5, 5, { duration: 0, estimated: false }),
          sliceAt('strip-qa', 'strip', 5, 9, { roleId: 'qa' }),
          sliceAt('sand-dev', 'sand', 9, 11, { boundBy: 'predecessor' }),
        ],
        dependencies: [{ predecessorId: 'strip', successorId: 'sand' }],
      }),
    );

    expect(chart.arrows[0]).toMatchObject({ fromStart: 5, fromFinish: 9, toStart: 9 });
  });

  it('a zero-length anchor draws from its own day', () => {
    // Nobody estimated any of `strip`, so there is no estimated slice to
    // anchor on and the walk falls through to its last — which for a work item
    // of no days at all stands at day 5 with no days in it. The
    // `fromStart === fromFinish` calendar reading, built for zero-day
    // projections, is what keeps the arrow leaving where day 5 begins, the
    // Monday at 7, not the end of the workday before it at 5.
    const chart = layOutGantt(
      planOf({
        rows: [rowAt('strip', 5, 5), rowAt('sand', 5, 7)],
        slices: [
          sliceAt('strip-dev', 'strip', 5, 5, { duration: 0, estimated: false }),
          sliceAt('strip-qa', 'strip', 5, 5, {
            roleId: 'qa',
            duration: 0,
            estimated: false,
          }),
          sliceAt('sand-dev', 'sand', 5, 7, { boundBy: 'predecessor' }),
        ],
        dependencies: [{ predecessorId: 'strip', successorId: 'sand' }],
      }),
    );

    expect(chart.arrows[0]).toMatchObject({ fromStart: 5, fromFinish: 5 });

    const placed = placeOnCalendar(chart, '2026-08-10');
    expect(placed.arrows[0].fromX).toBe(7);
  });

  it('throws when a shown predecessor has no slice in the payload at all', () => {
    // Not a collapsed row — `strip` is on the chart — and be-01 emits at least
    // one slice for every leaf, so a shown predecessor with none anywhere is a
    // broken promise: the arrow has no anchor to leave, and a chart quietly
    // short one arrow would hide exactly the wait it exists to show.
    const missing = planOf({
      rows: [rowAt('strip', 0, 3), rowAt('sand', 3, 5)],
      slices: [sliceAt('sand-dev', 'sand', 3, 5)],
      dependencies: [{ predecessorId: 'strip', successorId: 'sand' }],
    });

    expect(() => layOutGantt(missing)).toThrow(GanttDataError);
    expect(() => layOutGantt(missing)).toThrow('no slice');
  });
});

describe('the rest of the chart', () => {
  it('labels every shown row in the plan order, with its number and its depth', () => {
    const chart = layOutGantt(
      planOf({
        rows: [
          rowAt('phase', 0, 6, { leaf: false, number: '010', name: 'Prep' }),
          rowAt('strip', 0, 3, { depth: 1, number: '010.1', name: 'Strip' }),
        ],
        slices: [sliceAt('strip-dev', 'strip', 0, 3)],
      }),
    );

    // Proof: `number: row.number` dropped from the label — this test alone
    // failed, on `expected { id: 'phase', name: 'Prep', … } to deeply equal {
    // id: 'phase', number: '010', … }`, and the panel drew a column of names
    // with no numbers in it. Watched, 2026-08-09.
    expect(chart.labels).toEqual([
      { id: 'phase', number: '010', name: 'Prep', depth: 0, rowIndex: 0 },
      { id: 'strip', number: '010.1', name: 'Strip', depth: 1, rowIndex: 1 },
    ]);
  });

  it('names the work item a bar is for by number as well as by name', () => {
    const chart = layOutGantt(
      planOf({
        rows: [rowAt('strip', 0, 3, { number: '010', name: 'Strip the hull' })],
        slices: [sliceAt('strip-dev', 'strip', 0, 3)],
      }),
    );

    expect(chart.bars.map((bar) => [bar.workItemNumber, bar.workItemName])).toEqual([
      ['010', 'Strip the hull'],
    ]);
  });

  it('flags a row that may not start before a workday', () => {
    const chart = layOutGantt(
      planOf({
        rows: [rowAt('strip', 0, 3), rowAt('sand', 4, 6, { notBeforeOffset: 4 })],
        slices: [sliceAt('strip-dev', 'strip', 0, 3), sliceAt('sand-dev', 'sand', 4, 6)],
      }),
    );

    expect(chart.notBeforeFlags).toEqual([{ rowIndex: 1, offset: 4 }]);
  });

  it('reaches as far as the latest finish of anything drawn', () => {
    const chart = layOutGantt(
      planOf({
        rows: [rowAt('phase', 0, 9, { leaf: false }), rowAt('strip', 0, 3, { depth: 1 })],
        slices: [sliceAt('strip-dev', 'strip', 0, 3)],
      }),
    );

    expect(chart.horizon).toBe(9);
  });

  it('still has a horizon to draw in when there is nothing on it', () => {
    const chart = layOutGantt(planOf({}));

    expect(chart.horizon).toBe(1);
    expect(chart.bars).toEqual([]);
    expect(chart.labels).toEqual([]);
  });

  it('throws when a slice is under a role the plan does not list', () => {
    const strangerRole = planOf({
      rows: [rowAt('strip', 0, 3)],
      slices: [sliceAt('strip-ops', 'strip', 0, 3, { roleId: 'ops' })],
    });

    expect(() => layOutGantt(strangerRole)).toThrow(GanttDataError);
    expect(() => layOutGantt(strangerRole)).toThrow('does not list');
  });

  it('puts a slice belonging to no role after the ones that do', () => {
    const chart = layOutGantt(
      planOf({
        rows: [rowAt('strip', 0, 5)],
        slices: [
          sliceAt('strip-none', 'strip', 3, 5, { roleId: null }),
          sliceAt('strip-dev', 'strip', 0, 3),
        ],
      }),
    );

    expect(chart.bars.map((bar) => bar.sliceId)).toEqual(['strip-dev', 'strip-none']);
  });
});

describe('what a bar knows about itself', () => {
  it('names its work item, its role and its person, and carries its float', () => {
    const chart = layOutGantt(
      planOf({
        rows: [rowAt('strip', 0, 3, { name: 'Strip the hull' })],
        slices: [
          sliceAt('strip-dev', 'strip', 0, 3, { personId: 'kat', float: 2.5 }),
          sliceAt('strip-qa', 'strip', 3, 4, { roleId: 'qa' }),
        ],
      }),
    );

    expect(
      chart.bars.map((bar) => [bar.workItemName, bar.roleName, bar.personName, bar.float]),
    ).toEqual([
      ['Strip the hull', 'Dev', 'Kat', 2.5],
      ['Strip the hull', 'QA', null, 0],
    ]);
  });

  it('leaves the role nameless on a slice that belongs to none', () => {
    const chart = layOutGantt(
      planOf({
        rows: [rowAt('strip', 0, 3)],
        slices: [sliceAt('strip-none', 'strip', 0, 3, { roleId: null })],
      }),
    );

    expect(chart.bars[0].roleName).toBeNull();
  });

  it('throws when a slice is assigned to somebody the plan does not name', () => {
    // Not a person floor: an ordinary bar, assigned to an id the roster has
    // lost. The colour and the on-bar label are both that name, so a chart
    // drawn anyway would carry an anonymous colour nobody could ask about.
    const stranger = planOf({
      rows: [rowAt('strip', 0, 3)],
      slices: [sliceAt('strip-dev', 'strip', 0, 3, { personId: 'nobody-here' })],
    });

    expect(() => layOutGantt(stranger)).toThrow(GanttDataError);
    expect(() => layOutGantt(stranger)).toThrow('does not name');
  });

  it('throws when a person floor names nobody at all', () => {
    const nameless = planOf({
      rows: [rowAt('strip', 0, 3), rowAt('sand', 3, 5)],
      slices: [
        sliceAt('strip-dev', 'strip', 0, 3),
        sliceAt('sand-dev', 'sand', 3, 5, {
          boundBy: 'person',
          resourcePredecessorId: 'strip-dev',
        }),
      ],
    });

    expect(() => layOutGantt(nameless)).toThrow(GanttDataError);
    expect(() => layOutGantt(nameless)).toThrow('no person at all');
  });
});

describe('tags reach the bar and nothing that computes a position', () => {
  /**
   * One plan drawn twice over: a parent, two leaves, an edge between them and a
   * manual start date — a chart with a bar, a bracket, an arrow and a flag on
   * it, so "nothing moved" is a claim about every kind of mark rather than
   * about bars alone.
   */
  const planWith = (tags: TagLabel, extras: Partial<GanttSlice> = {}): GanttPlan =>
    planOf({
      rows: [
        rowAt('backend', 0, 5, { depth: 0, leaf: false, number: '010', name: 'Backend' }),
        rowAt('strip', 0, 3, { depth: 1, tags }),
        rowAt('sand', 3, 5, { depth: 1, notBeforeOffset: 3 }),
      ],
      slices: [
        sliceAt('strip-dev', 'strip', 0, 3, extras),
        sliceAt('strip-qa', 'strip', 3, 4, { roleId: 'qa' }),
        sliceAt('sand-dev', 'sand', 3, 5, { boundBy: 'predecessor' }),
      ],
      dependencies: [{ predecessorId: 'strip', successorId: 'sand' }],
    });

  /** The whole chart with the field under test flattened to one constant. */
  const everythingElse = (chart: GanttGeometry): unknown => ({
    ...chart,
    bars: chart.bars.map((bar) => ({ ...bar, tags: 'not compared here' })),
  });

  it('carries the row’s tags onto every bar drawn for that row', () => {
    const chart = layOutGantt(planWith({ state: 'named', names: ['Compliance', 'Rework'] }));

    // Both of the tagged row's bars, because the surface is built per bar: a
    // reader hovering the QA bar of a compliance job is owed the same sentence
    // as one hovering its Dev bar.
    expect(chart.bars.map((bar) => [bar.sliceId, bar.tags])).toEqual([
      ['strip-dev', { state: 'named', names: ['Compliance', 'Rework'] }],
      ['strip-qa', { state: 'named', names: ['Compliance', 'Rework'] }],
      ['sand-dev', { state: 'none' }],
    ]);
  });

  it('carries an inherited set with the ancestor it came from', () => {
    const inherited = {
      state: 'inherited',
      names: ['Compliance'],
      fromRow: '010 Backend',
    } as const;
    const chart = layOutGantt(planWith(inherited));

    expect(chart.bars[0].tags).toEqual(inherited);
  });

  it('places every mark at the same number tagged and untagged', () => {
    const untagged = layOutGantt(planWith({ state: 'none' }));
    const tagged = layOutGantt(planWith({ state: 'named', names: ['Compliance', 'Rework'] }));
    const inherited = layOutGantt(
      planWith({ state: 'inherited', names: ['Compliance'], fromRow: '010 Backend' }),
    );

    expect(everythingElse(tagged)).toEqual(everythingElse(untagged));
    expect(everythingElse(inherited)).toEqual(everythingElse(untagged));
    // The floor sentence too, which is the one string on a bar that is computed
    // from what is holding it up: a tag is not among the things that can.
    expect(tagged.bars.map((bar) => bar.floorWords)).toEqual(
      untagged.bars.map((bar) => bar.floorWords),
    );
  });

  it('control: the same comparison catches a mark that really did move', () => {
    // Without this, the assertion above passes on a build that lays out
    // nothing — the lesson `tag-empty-diff.test.ts` was rewritten for. A
    // one-workday shift in a slice has to come out as a difference here, or the
    // comparison is not measuring the chart.
    const untagged = layOutGantt(planWith({ state: 'none' }));
    const moved = layOutGantt(planWith({ state: 'none' }, { earliestStart: 1 }));

    expect(everythingElse(moved)).not.toEqual(everythingElse(untagged));
  });
});

describe('bar colours are people', () => {
  /** A plan of `count` leaves, one slice each, one person per leaf. */
  const oneLeafPer = (personIds: readonly (string | null)[]): GanttPlan =>
    planOf({
      rows: personIds.map((_, at) => rowAt(`row-${String(at)}`, at, at + 1)),
      slices: personIds.map((personId, at) =>
        sliceAt(`slice-${String(at)}`, `row-${String(at)}`, at, at + 1, { personId }),
      ),
      personNames: new Map(
        personIds
          .filter((personId): personId is string => personId !== null)
          .map((personId) => [personId, personId.toUpperCase()]),
      ),
    });

  it('gives one person one colour on every row they are on', () => {
    const chart = layOutGantt(oneLeafPer(['kat', 'ravi', 'kat']));

    expect(chart.bars[0].personColor).toBe(chart.bars[2].personColor);
    expect(chart.bars[1].personColor).not.toBe(chart.bars[0].personColor);
  });

  it('hands the palette out in the order people first appear, top-down', () => {
    // `ravi` is on the row above `kat`, so `ravi` takes the first colour —
    // nothing about the payload's slice order or the alphabet comes into it.
    const chart = layOutGantt(oneLeafPer(['ravi', 'kat']));

    expect(chart.bars.map((bar) => bar.personColor)).toEqual([
      PERSON_BAR_COLORS[0],
      PERSON_BAR_COLORS[1],
    ]);
  });

  it('wraps the eleventh person back onto the first colour', () => {
    const eleven = Array.from({ length: 11 }, (_, at) => `person-${String(at)}`);
    const chart = layOutGantt(oneLeafPer(eleven));

    expect(chart.bars).toHaveLength(11);
    expect(chart.bars.map((bar) => bar.personColor).slice(0, 10)).toEqual([...PERSON_BAR_COLORS]);
    expect(chart.bars[10].personColor).toBe(PERSON_BAR_COLORS[0]);
  });

  /**
   * Ten hues cannot share one ink. `#bcbd22` is a highlighter and `#17becf` is
   * a swimming pool; white on either is a label nobody reads, and `#ff7f0e` is
   * not much better.
   */
  it('writes the label in ink the bar can be read through', () => {
    expect(inkOn('#bcbd22')).toBe('#0f172a');
    expect(inkOn('#17becf')).toBe('#0f172a');
    expect(inkOn('#ff7f0e')).toBe('#0f172a');
    expect(inkOn('#1f77b4')).toBe('#ffffff');
    expect(inkOn('#d62728')).toBe('#ffffff');
    expect(inkOn('#8c564b')).toBe('#ffffff');
    // And every colour in the palette gets one of exactly those two answers.
    const everyBarColor: BarColor[] = [...PERSON_BAR_COLORS, UNASSIGNED_BAR_COLOR];
    expect(new Set(everyBarColor.map((color) => inkOn(color)))).toEqual(
      new Set(['#0f172a', '#ffffff']),
    );
  });

  it('paints a slice nobody is on grey, and does not spend a colour on it', () => {
    const chart = layOutGantt(oneLeafPer([null, 'kat']));

    expect(chart.bars[0].personColor).toBe(UNASSIGNED_BAR_COLOR);
    // The unassigned row did not take the first colour with it: `kat` is still
    // the first person, and still the first colour.
    expect(chart.bars[1].personColor).toBe(PERSON_BAR_COLORS[0]);
    expect(UNASSIGNED_BAR_COLOR).not.toBe(PERSON_BAR_COLORS[0]);
  });
});

describe('the shapes a real schedule makes', () => {
  it('keeps the plan’s own row order when the starts are out of it', () => {
    // The anti-reference test. A Gantt sorted by start date would put `Rigging`
    // at the top; this one mirrors the tree, and the tree says `Hull` first.
    const chart = layOutGantt(
      planOf({
        rows: [rowAt('hull', 4, 7), rowAt('rigging', 0, 2), rowAt('sails', 2, 4)],
        slices: [
          sliceAt('hull-dev', 'hull', 4, 7),
          sliceAt('rigging-dev', 'rigging', 0, 2),
          sliceAt('sails-dev', 'sails', 2, 4),
        ],
      }),
    );

    expect(chart.labels.map((label) => label.id)).toEqual(['hull', 'rigging', 'sails']);
    expect(chart.bars.map((bar) => [bar.sliceId, bar.rowIndex, bar.start])).toEqual([
      ['hull-dev', 0, 4],
      ['rigging-dev', 1, 0],
      ['sails-dev', 2, 2],
    ]);
  });

  it('spans a grandparent over the parent that spans the leaves', () => {
    const chart = layOutGantt(
      planOf({
        rows: [
          rowAt('boat', 0, 9, { leaf: false }),
          rowAt('hull', 0, 6, { leaf: false, depth: 1 }),
          rowAt('strip', 0, 3, { depth: 2 }),
          rowAt('sand', 2, 6, { depth: 2 }),
          rowAt('rig', 6, 9, { depth: 1 }),
        ],
        slices: [
          sliceAt('strip-dev', 'strip', 0, 3),
          sliceAt('sand-dev', 'sand', 2, 6),
          sliceAt('rig-dev', 'rig', 6, 9),
        ],
      }),
    );

    expect(chart.brackets).toEqual([
      { rowId: 'boat', rowIndex: 0, start: 0, finish: 9 },
      { rowId: 'hull', rowIndex: 1, start: 0, finish: 6 },
    ]);
    // The nesting is the two brackets' spans, and the grandparent reaches past
    // the parent because a leaf outside it does.
    expect(chart.bars.map((bar) => bar.rowIndex)).toEqual([2, 3, 4]);
    expect(chart.horizon).toBe(9);
  });

  /**
   * A three-slice PERT chain, in the numbers PERT actually produces.
   *
   * `(1 + 4×3 + 8) / 6` is 3.5 and `(2 + 4×4 + 5) / 6` is 3.8333333333333335;
   * the third starts where the second finishes, which is a sum of two of those.
   * Every one of them reaches the bar untouched — this is the assertion that
   * says nothing here rounds on the way.
   */
  it('carries a PERT chain’s fractions through to every bar, verbatim', () => {
    const first = 3.5;
    const second = 3.8333333333333335;
    const third = 3.6666666666666665;
    const chart = layOutGantt(
      planOf({
        rows: [rowAt('a', 0, first), rowAt('b', first, first + second)],
        slices: [
          sliceAt('a-dev', 'a', 0, first, { duration: first }),
          sliceAt('a-qa', 'a', first, first + third, { roleId: 'qa', duration: third }),
          sliceAt('b-dev', 'b', first, first + second, {
            duration: second,
            boundBy: 'roleOrder',
          }),
        ],
      }),
    );

    expect(chart.bars.map((bar) => [bar.start, bar.duration, bar.finish])).toEqual([
      [0, 3.5, 3.5],
      [3.5, 3.6666666666666665, 7.166666666666666],
      [3.5, 3.8333333333333335, 7.333333333333334],
    ]);
    expect(chart.horizon).toBe(7.333333333333334);
  });

  it('holds a not-before flag at its exact offset, with the bar sitting on it', () => {
    const chart = layOutGantt(
      planOf({
        rows: [rowAt('strip', 0, 3), rowAt('sand', 4.5, 6.5, { notBeforeOffset: 4.5 })],
        slices: [
          sliceAt('strip-dev', 'strip', 0, 3),
          sliceAt('sand-dev', 'sand', 4.5, 6.5, { boundBy: 'notBefore' }),
        ],
      }),
    );

    expect(chart.notBeforeFlags).toEqual([{ rowIndex: 1, offset: 4.5 }]);
    // The flag and the bar are the same number: the date is the floor, and the
    // bar is standing on it. A flag drawn anywhere else would be the chart
    // disagreeing with itself about the same day.
    expect(chart.bars[1].start).toBe(chart.notBeforeFlags[0].offset);
    expect(chart.bars[1].floorWords).toBe('Held by its start-no-earlier-than date');
  });

  /**
   * A slice **estimated** at no days: real, and drawn as a mark of no width.
   *
   * `expectedDays({0, 0, 0})` is 0 — `libs/domain/src/estimate.test.ts` says so
   * — so a slice somebody has estimated can still be zero workdays long. The
   * geometry keeps the bar, the panel draws a tick at its start because a
   * `<rect width="0">` paints nothing, and it takes no room on the axis and
   * moves the horizon nowhere. An unestimated slice is the test below, and it
   * is a different answer.
   */
  it('keeps a zero-day estimate as a bar of no width that takes no room', () => {
    const chart = layOutGantt(
      planOf({
        rows: [rowAt('strip', 0, 3), rowAt('sand', 3, 3)],
        slices: [
          sliceAt('strip-dev', 'strip', 0, 3),
          sliceAt('sand-dev', 'sand', 3, 3, { duration: 0 }),
        ],
      }),
    );

    expect(chart.bars.map((bar) => [bar.sliceId, bar.start, bar.duration, bar.drawnSpan])).toEqual([
      ['strip-dev', 0, 3, 3],
      ['sand-dev', 3, 0, 0],
    ]);
    expect(chart.horizon).toBe(3);
  });

  /**
   * An unestimated slice: zero days on the engine, two workdays on the paper.
   *
   * The engine's numbers are untouched — `duration`, `start` and `finish` are
   * what be-01 sent — and `drawnSpan` alone carries the assumption. See
   * {@link ASSUMED_UNESTIMATED_WORKDAYS}.
   */
  it('draws an unestimated slice across the assumed span, from its engine start', () => {
    const chart = layOutGantt(
      planOf({
        rows: [rowAt('strip', 0, 3), rowAt('sand', 3, 3)],
        slices: [
          sliceAt('strip-dev', 'strip', 0, 3),
          sliceAt('sand-dev', 'sand', 3, 3, { estimated: false }),
        ],
      }),
    );

    // Proof: `drawnSpan: slice.estimated ? slice.duration :
    // ASSUMED_UNESTIMATED_WORKDAYS` reverted to `drawnSpan: slice.duration` —
    // the zero-width tick this change exists to replace. **Both** tests here
    // failed: this one on `expected [ …, [ 'sand-dev', 3, 3, 0 ] ] to deeply
    // equal [ …, [ 'sand-dev', 3, 3, 2 ] ]`, and `stretches the horizon to hold
    // the assumed span` on `expected 3 to be 5`. Watched, 2026-08-09.
    expect(
      chart.bars.map((bar) => [bar.sliceId, bar.start, bar.duration, bar.drawnSpan, bar.estimated]),
    ).toEqual([
      ['strip-dev', 0, 3, 3, true],
      ['sand-dev', 3, 0, ASSUMED_UNESTIMATED_WORKDAYS, false],
    ]);
  });

  it('stretches the horizon to hold the assumed span, so the ghost bar has canvas', () => {
    const chart = layOutGantt(
      planOf({
        rows: [rowAt('strip', 0, 3), rowAt('sand', 3, 3)],
        slices: [
          sliceAt('strip-dev', 'strip', 0, 3),
          sliceAt('sand-dev', 'sand', 3, 3, { estimated: false }),
        ],
      }),
    );

    // Proof, of the horizon's own half: `Math.max(horizon, bar.finish,
    // bar.start + bar.drawnSpan)` cut back to `Math.max(horizon, bar.finish)`,
    // with the drawn span left in place — this test alone failed, on `expected
    // 3 to be 5`, and the two-day bar hung two workdays off the end of a canvas
    // that stopped at 3. Watched, 2026-08-09.
    expect(chart.horizon).toBe(3 + ASSUMED_UNESTIMATED_WORKDAYS);
  });

  it('draws nothing, and throws nothing, for a plan with no rows at all', () => {
    const chart = layOutGantt(planOf({}));

    expect(chart).toEqual({
      labels: [],
      bars: [],
      brackets: [],
      arrows: [],
      personLinks: [],
      capacityLinks: [],
      notBeforeFlags: [],
      droppedLinks: { dependencies: 0, personLinks: 0, capacityLinks: 0 },
      horizon: 1,
    });
  });
});

/**
 * The scale on its own, before any mark is placed through it.
 *
 * Every case below is taken at an offset **past the first weekend**, where the
 * calendar number and the workday number differ. A case at workday 3 passes
 * unchanged on the axis this replaces and so proves nothing.
 */
describe('the calendar scale', () => {
  /** The Monday every fixture in here begins on. */
  const MONDAY = '2026-08-10';

  it('keeps a fraction inside the workday it belongs to', () => {
    const scale = calendarScale(MONDAY);

    // Before any weekend has passed the two axes agree, fractions included: a
    // slice 3.5 workdays into the schedule is still 3.5 workdays into it.
    expect(scale.startOf(3.5)).toBe(3.5);
    expect(scale.startOf(4.75)).toBe(4.75);
  });

  it('jumps the weekend', () => {
    const scale = calendarScale(MONDAY);

    // Monday 2026-08-17 and Monday 2026-08-24 — the whole point of the change,
    // in three numbers.
    expect(scale.startOf(5)).toBe(7);
    expect(scale.startOf(5.25)).toBe(7.25);
    expect(scale.startOf(10)).toBe(14);
  });

  it('ends a span that finished on the Friday at the Saturday', () => {
    const scale = calendarScale(MONDAY);

    // A span 3 → 5 stops where the Friday stops, and its successor starting at
    // the same 5 stands at 7 — the Monday. The two readings differ by exactly
    // the weekend between them, which is the gap a reader sees.
    expect(scale.startOf(3)).toBe(3);
    expect(scale.endOf(5)).toBe(5);
    expect(scale.startOf(5)).toBe(7);
  });

  it('draws across a weekend a span runs through', () => {
    const scale = calendarScale(MONDAY);

    // 3 → 6 works on the Monday after, so the weekend is inside the span and
    // the bar is drawn over it rather than skipping it.
    expect(scale.endOf(6)).toBe(8);
  });

  it('begins a Saturday project on the Monday', () => {
    // The normalisation `addWorkdays` already makes, inherited rather than
    // re-implemented: a project starting Saturday 2026-08-08 answers exactly
    // like one starting on the Monday after it.
    const scale = calendarScale('2026-08-08');

    expect(scale.startOf(0)).toBe(0);
    expect(scale.startOf(5)).toBe(7);
    expect(scale.endOf(5)).toBe(5);
  });

  it('reads a drifted whole offset exactly as the whole day it is', () => {
    const scale = calendarScale(MONDAY);

    // The engine's chained doubles drift to either side of a whole day —
    // 1/6 + 49/6 + 4/6 arrives as 8.999999999999998 — and the scale must
    // answer what it answers for the whole day, or the chart stands a bar
    // almost a full calendar day away from the dates printed beside it.
    expect(scale.startOf(8.999999999999998)).toBe(scale.startOf(9));
    expect(scale.startOf(5.000000000000001)).toBe(scale.startOf(5));
    // The end reading has more to lose: a drifted 15.000000000000002 read as
    // fractional takes the *start* reading — the far side of the weekend —
    // instead of the end of day 14.
    expect(scale.endOf(15.000000000000002)).toBe(scale.endOf(15));
    expect(scale.endOf(8.999999999999998)).toBe(scale.endOf(9));
  });

  it('answers below zero rather than throwing', () => {
    const scale = calendarScale(MONDAY);

    // The band outside the schedule is canvas and not schedule time, and
    // `addWorkdays` refuses it. One calendar day per unit out there.
    expect(scale.startOf(-0.25)).toBe(-0.25);
    expect(scale.endOf(-0.25)).toBe(-0.25);
    expect(scale.startOf(0)).toBe(0);
    expect(scale.endOf(0)).toBe(0);
  });

  it('refuses a start date that is not a calendar date', () => {
    expect(() => calendarScale('2026-02-31')).toThrow(/not a calendar date/);
  });
});

/**
 * Every mark placed through the scale at once, which is the point: a mark left
 * on a workday number misaligns from the first weekend on, and only a fixture
 * that reaches past one can see it.
 */
describe('placing the chart on a calendar', () => {
  /** The Monday every fixture in here begins on. */
  const MONDAY = '2026-08-10';

  it('puts a bar at the calendar day its workday is', () => {
    const chart = layOutGantt(
      planOf({
        rows: [rowAt('strip', 5, 8)],
        slices: [sliceAt('strip-dev', 'strip', 5, 8)],
      }),
    );

    const placed = placeOnCalendar(chart, MONDAY);

    // Workday 5 is Monday 2026-08-17, seven calendar days in, and the three
    // workdays after it are the Mon/Tue/Wed with no weekend among them.
    expect(placed.bars[0].x).toBe(7);
    expect(placed.bars[0].width).toBe(3);
    // And the engine's own bar rides along untouched, which is what
    // `data-start`/`data-finish` and every sentence are written from.
    expect(placed.bars[0].bar.start).toBe(5);
    expect(placed.bars[0].bar.finish).toBe(8);
    expect(chart.bars[0].start).toBe(5);
  });

  it('draws a bar across the weekend it works through, and not one it stops before', () => {
    const chart = layOutGantt(
      planOf({
        rows: [rowAt('strip', 3, 5), rowAt('sand', 3, 6)],
        slices: [sliceAt('strip-dev', 'strip', 3, 5), sliceAt('sand-dev', 'sand', 3, 6)],
      }),
    );

    const placed = placeOnCalendar(chart, MONDAY);

    // 3 → 5 is the Thursday and the Friday: two days wide, with no weekend
    // tail. 3 → 6 works on the Monday after, so its bar is drawn over the
    // weekend inside it and is five days wide.
    expect([placed.bars[0].x, placed.bars[0].width]).toEqual([3, 2]);
    expect([placed.bars[1].x, placed.bars[1].width]).toEqual([3, 5]);
  });

  it('spans a bracket from its earliest start to its latest finish, on the calendar', () => {
    const chart = layOutGantt(
      planOf({
        rows: [
          rowAt('hull', 0, 6, { leaf: false }),
          rowAt('strip', 0, 3, { depth: 1 }),
          rowAt('sand', 2, 6, { depth: 1 }),
        ],
        slices: [sliceAt('strip-dev', 'strip', 0, 3), sliceAt('sand-dev', 'sand', 2, 6)],
      }),
    );

    const placed = placeOnCalendar(chart, MONDAY);

    expect(placed.brackets[0].from).toBe(0);
    expect(placed.brackets[0].to).toBe(8);
  });

  it('leaves a weekend between a predecessor’s finish and its successor’s start', () => {
    const chart = layOutGantt(
      planOf({
        rows: [rowAt('strip', 0, 5), rowAt('sand', 5, 7)],
        slices: [
          sliceAt('strip-dev', 'strip', 0, 5, { personId: 'kat' }),
          sliceAt('sand-dev', 'sand', 5, 7, {
            personId: 'kat',
            boundBy: 'person',
            resourcePredecessorId: 'strip-dev',
          }),
        ],
        dependencies: [{ predecessorId: 'strip', successorId: 'sand' }],
      }),
    );

    const placed = placeOnCalendar(chart, MONDAY);

    // The hand-off across a weekend, on both marks that draw one: the arrow
    // leaves the Friday's right edge at 5 and arrives at the Monday at 7, so
    // the two bars do not touch.
    expect([placed.arrows[0].fromX, placed.arrows[0].toX]).toEqual([5, 7]);
    expect([placed.personLinks[0].fromX, placed.personLinks[0].toX]).toEqual([5, 7]);
    expect(placed.bars[0].x + placed.bars[0].width).toBe(5);
    expect(placed.bars[1].x).toBe(7);
  });

  it('stands a not-before flag on the calendar day its workday is', () => {
    const chart = layOutGantt(
      planOf({
        rows: [rowAt('sand', 5, 7, { notBeforeOffset: 5 })],
        slices: [sliceAt('sand-dev', 'sand', 5, 7)],
      }),
    );

    const placed = placeOnCalendar(chart, MONDAY);

    expect(placed.notBeforeFlags[0].x).toBe(7);
    // And the workday it holds at rides along, because the words the caret
    // shows are date arithmetic on that number and never on the coordinate.
    expect(placed.notBeforeFlags[0].workday).toBe(5);
  });

  it('reaches a horizon that holds an assumed span in calendar days', () => {
    const chart = layOutGantt(
      planOf({
        rows: [rowAt('sand', 3, 3)],
        slices: [sliceAt('sand-dev', 'sand', 3, 3, { duration: 0, estimated: false })],
      }),
    );

    const placed = placeOnCalendar(chart, MONDAY);

    // Two workdays drawn from the Thursday is the Friday, and the horizon
    // stops there rather than at the workday number 3 the engine gave.
    expect(chart.horizon).toBe(3 + ASSUMED_UNESTIMATED_WORKDAYS);
    expect(placed.horizon).toBe(5);
    expect(placed.bars[0].width).toBe(2);
  });

  it('leaves a mark of no days standing where it starts, not behind it', () => {
    const chart = layOutGantt(
      planOf({
        // Everything here is on the Monday past the first weekend, where a
        // finish reading and a start reading are two calendar days apart: a
        // zero-day estimate, a parent projecting nothing, and an arrow leaving
        // that parent. Read as a finish alone, all three would be drawn at 5
        // — the Friday's edge — while the day they belong to is 7.
        rows: [
          rowAt('hull', 5, 5, { leaf: false }),
          rowAt('strip', 5, 5, { depth: 1 }),
          rowAt('sand', 5, 7),
        ],
        slices: [
          sliceAt('strip-dev', 'strip', 5, 5, { duration: 0 }),
          sliceAt('sand-dev', 'sand', 5, 7),
        ],
        dependencies: [{ predecessorId: 'hull', successorId: 'sand' }],
      }),
    );

    const placed = placeOnCalendar(chart, MONDAY);

    // The zero-day estimate keeps its zero width and stands on the Monday.
    expect([placed.bars[0].x, placed.bars[0].width]).toEqual([7, 0]);
    expect(placed.brackets[0]).toMatchObject({ from: 7, to: 7 });
    expect(placed.arrows[0].fromX).toBe(7);
  });

  it('places a plan with no start date on the workdays it came in on', () => {
    const chart = layOutGantt(
      planOf({
        rows: [
          rowAt('hull', 0, 7, { leaf: false }),
          rowAt('strip', 0, 5, { depth: 1 }),
          rowAt('sand', 5, 7, { depth: 1, notBeforeOffset: 5 }),
        ],
        slices: [sliceAt('strip-dev', 'strip', 0, 5), sliceAt('sand-dev', 'sand', 5, 7)],
        dependencies: [{ predecessorId: 'strip', successorId: 'sand' }],
      }),
    );

    const placed = placeOnWorkdays(chart);

    // Not a calendar at all: every number is the engine's own, which is what
    // the panel draws while a plan has no start date.
    expect([placed.bars[1].x, placed.bars[1].width]).toEqual([5, 2]);
    expect(placed.brackets[0].to).toBe(7);
    expect([placed.arrows[0].fromX, placed.arrows[0].toX]).toEqual([5, 5]);
    expect(placed.notBeforeFlags[0].x).toBe(5);
    expect(placed.horizon).toBe(chart.horizon);
  });
});

describe('routing an arrow past the bars it does not join', () => {
  /**
   * The panel's own two numbers, in the units {@link routeArrow} takes them in:
   * `ARROW_APPROACH_PX / DAY_PX` and `BAR_INSET`.
   *
   * Stated here rather than imported because the router's promise is about
   * **any** clearance — a chart drawn at another day width keeps it — and
   * because a geometry test that reached into the panel for its numbers would
   * be measuring the panel. What proves the panel passes these is a panel test:
   * `no arrow crosses a bar it does not join` in `gantt-panel.test.tsx`.
   */
  const CLEARANCE = { approach: 10 / 28, barInset: 0.18 };

  /** Where a bar is painted, in the two units the route is in. */
  const rectOf = (placed: PlacedBar) => ({
    left: placed.x,
    right: placed.x + placed.width,
    top: placed.bar.rowIndex + CLEARANCE.barInset,
    bottom: placed.bar.rowIndex + 1 - CLEARANCE.barInset,
  });

  /**
   * Whether one run of a route passes through the inside of one bar — read
   * apart from the router's own `runCrossesBar` on purpose.
   *
   * Written as the two cases a route can have rather than as one overlap
   * formula, so that a wrong reading inside the router cannot make every
   * assertion below agree with it. A run that is neither horizontal nor
   * vertical is a route this module does not draw, and it fails here rather
   * than being measured: see `every run is horizontal or vertical` below.
   */
  const runsInside = (
    from: { x: number; y: number },
    to: { x: number; y: number },
    rect: { left: number; right: number; top: number; bottom: number },
  ): boolean => {
    const spans = (low: number, high: number, from_: number, to_: number): boolean =>
      Math.min(from_, to_) < high && Math.max(from_, to_) > low;
    if (from.x === to.x) {
      return (
        from.x > rect.left && from.x < rect.right && spans(rect.top, rect.bottom, from.y, to.y)
      );
    }
    if (from.y === to.y) {
      return (
        from.y > rect.top && from.y < rect.bottom && spans(rect.left, rect.right, from.x, to.x)
      );
    }
    throw new Error(`a route ran from ${String(from.x)},${String(from.y)} diagonally`);
  };

  /** How a chart's arrows are routed: this module's answer unless a test says otherwise. */
  type Router = (arrow: PlacedArrow, drawn: PlacedBar[]) => { x: number; y: number }[];

  const asItRoutes: Router = (arrow, drawn) => routeArrow(arrow, drawn, CLEARANCE);

  /** Every (arrow, bar) pair the chart draws through, named the way a reader would find it. */
  const crossingsIn = (placed: PlacedGantt, route_: Router = asItRoutes): string[] => {
    // The bars the panel paints, which since `gantt-declutter` is the estimated
    // ones — and the same list the panel hands the router.
    const drawn = placed.bars.filter(({ bar }) => bar.estimated);
    const found: string[] = [];
    for (const arrow of placed.arrows) {
      const route = route_(arrow, drawn);
      for (const [index, corner] of route.entries()) {
        if (index === 0) continue;
        for (const bar of drawn) {
          if (!runsInside(route[index - 1], corner, rectOf(bar))) continue;
          found.push(
            `${arrow.predecessorId}->${arrow.successorId} run ${String(index)} ` +
              `crosses ${bar.bar.sliceId}`,
          );
        }
      }
    }
    return found;
  };

  /**
   * A10's fixture, on the workday axis: `010` 3 days, `020` 2 and `030` 4 both
   * waiting on it, `040` 2 waiting on both.
   *
   * The shape the defect was measured on. `020` finishes at 5 and `040` starts
   * at 7, so the old router had room for its plain elbow and turned down one
   * approach short of 7 — straight through `030`, which runs 3 → 7 on the row
   * in between.
   */
  const a10 = (): GanttPlan =>
    planOf({
      rows: [rowAt('010', 0, 3), rowAt('020', 3, 5), rowAt('030', 3, 7), rowAt('040', 7, 9)],
      slices: [
        sliceAt('010-dev', '010', 0, 3),
        sliceAt('020-dev', '020', 3, 5),
        sliceAt('030-dev', '030', 3, 7),
        sliceAt('040-dev', '040', 7, 9),
      ],
      dependencies: [
        { predecessorId: '010', successorId: '020' },
        { predecessorId: '010', successorId: '030' },
        { predecessorId: '020', successorId: '040' },
        { predecessorId: '030', successorId: '040' },
      ],
    });

  const routeOf = (placed: PlacedGantt, predecessorId: string, successorId: string) => {
    const arrow = placed.arrows.find(
      (each) => each.predecessorId === predecessorId && each.successorId === successorId,
    );
    if (arrow === undefined) throw new Error(`no arrow ${predecessorId} -> ${successorId}`);
    return routeArrow(
      arrow,
      placed.bars.filter(({ bar }) => bar.estimated),
      CLEARANCE,
    );
  };

  it('keeps every arrow of the A10 plan out of every bar', () => {
    // Proof: `routeArrow` given back the router this replaced — the plain elbow
    // whenever `toX - fromX >= 2 * approach` and the jog otherwise, with no
    // reading of the bars at all. This test alone failed on `expected [
    // '020->040 run 2 crosses 030-dev' ] to deeply equal []`, which is A10's
    // finding in one line. Watched 2026-08-12.
    expect(crossingsIn(placeOnWorkdays(layOutGantt(a10())))).toEqual([]);
  });

  it('keeps every arrow of the A10 plan out of every bar on a calendar too', () => {
    // The same plan with the weekends in it: `030` is drawn 3 → 9 rather than
    // 3 → 7, so the bar the descent has to clear is two calendar days wider
    // than the workdays say. Proof: the same router swap; `expected [
    // '020->040 run 2 crosses 030-dev' ] to deeply equal []`. Watched
    // 2026-08-12.
    expect(crossingsIn(placeOnCalendar(layOutGantt(a10()), '2026-06-01'))).toEqual([]);
  });

  it('dodges into the band beside the row it cannot descend through', () => {
    const route = routeOf(placeOnWorkdays(layOutGantt(a10())), '020', '040');
    const { approach, barInset } = CLEARANCE;

    // Out of `020`, into the band under its row, right past `030`'s finish,
    // down the two rows there, back to the turn and in. The exact corners,
    // because "it clears" is true of a route that goes around the whole chart
    // as well, and this one is the smallest dodge available.
    expect(route).toEqual([
      { x: 5, y: 1.5 },
      { x: 5 + approach, y: 1.5 },
      { x: 5 + approach, y: 2 - barInset / 2 },
      { x: 7 + approach, y: 2 - barInset / 2 },
      { x: 7 + approach, y: 3 - barInset / 2 },
      { x: 7 - approach, y: 3 - barInset / 2 },
      { x: 7 - approach, y: 3.5 },
      { x: 7, y: 3.5 },
    ]);
  });

  it('leaves the three arrows nothing stands under exactly where they were', () => {
    const placed = placeOnWorkdays(layOutGantt(a10()));
    const { approach, barInset } = CLEARANCE;

    // `010 -> 020` and `010 -> 030` touch, so both are the five-run jog the
    // panel has drawn since `gantt-polish`, and `030 -> 040` touches as well.
    // Nothing about a clear chart moved: the dodge is what the router adds.
    expect(routeOf(placed, '010', '020')).toEqual([
      { x: 3, y: 0.5 },
      { x: 3 + approach, y: 0.5 },
      { x: 3 + approach, y: 1 - barInset / 2 },
      { x: 3 - approach, y: 1 - barInset / 2 },
      { x: 3 - approach, y: 1.5 },
      { x: 3, y: 1.5 },
    ]);
    expect(routeOf(placed, '030', '040')).toEqual([
      { x: 7, y: 2.5 },
      { x: 7 + approach, y: 2.5 },
      { x: 7 + approach, y: 3 - barInset / 2 },
      { x: 7 - approach, y: 3 - barInset / 2 },
      { x: 7 - approach, y: 3.5 },
      { x: 7, y: 3.5 },
    ]);
  });

  it('still draws the plain elbow when the column it turns at is clear', () => {
    const placed = placeOnWorkdays(
      layOutGantt(
        planOf({
          rows: [rowAt('010', 0, 3), rowAt('020', 6, 8)],
          slices: [sliceAt('010-dev', '010', 0, 3), sliceAt('020-dev', '020', 6, 8)],
          dependencies: [{ predecessorId: '010', successorId: '020' }],
        }),
      ),
    );

    // Three runs and no band: the shape this chart has always drawn where there
    // is room and nothing in the way.
    expect(routeOf(placed, '010', '020')).toEqual([
      { x: 3, y: 0.5 },
      { x: 6 - CLEARANCE.approach, y: 0.5 },
      { x: 6 - CLEARANCE.approach, y: 1.5 },
      { x: 6, y: 1.5 },
    ]);
  });

  it('leaves on the anchor’s own edge when the next role stands against it', () => {
    const placed = placeOnWorkdays(
      layOutGantt(
        planOf({
          rows: [rowAt('010', 0, 5), rowAt('020', 5, 7)],
          slices: [
            sliceAt('010-dev', '010', 0, 3),
            sliceAt('010-qa', '010', 3, 5, { roleId: 'qa' }),
            sliceAt('020-dev', '020', 5, 7),
          ],
          dependencies: [{ predecessorId: '010', successorId: '020' }],
        }),
      ),
    );

    const route = routeOf(placed, '010', '020');
    // The arrow leaves the anchor — `dep-waits-on-first-role` — which is the
    // Dev bar's right edge at 3, and QA is drawn 3 → 5 right against it. So
    // there is nowhere to step out to: the route leaves on the edge itself and
    // drops into the band under the row.
    expect(route[0]).toEqual({ x: 3, y: 0.5 });
    expect(route[1]).toEqual({ x: 3, y: 1 - CLEARANCE.barInset / 2 });
    expect(crossingsIn(placed)).toEqual([]);
  });

  it('dodges the same way for an arrow that climbs the chart', () => {
    const placed = placeOnWorkdays(
      layOutGantt(
        planOf({
          // The payload's order is the tree's, and a successor is as often
          // drawn above its predecessor as below it. `030` waits on `010` two
          // rows down, and `020` sits between them across the column the
          // ascent would otherwise turn at.
          rows: [rowAt('030', 5, 7), rowAt('020', 3, 7), rowAt('010', 0, 3)],
          slices: [
            sliceAt('030-dev', '030', 5, 7),
            sliceAt('020-dev', '020', 3, 7),
            sliceAt('010-dev', '010', 0, 3),
          ],
          dependencies: [{ predecessorId: '010', successorId: '030' }],
        }),
      ),
    );

    const arrow = placed.arrows[0];
    // The case this test is for, asserted rather than assumed: a fixture that
    // drifted into descending would go on passing and prove nothing about the
    // direction it was written for.
    expect(arrow.toRowIndex).toBeLessThan(arrow.fromRowIndex);
    // Proof: `routeArrow` given back its pre-`arrow-dodge` body. There is
    // horizontal room between 3 and 5, so the old router drew the plain elbow
    // and turned up at 4.643 — inside `020`, which runs 3 → 7 on the row
    // between. Failed on `expected [ '010->030 run 2 crosses 020-dev' ] to
    // deeply equal []`. Watched 2026-08-12.
    expect(crossingsIn(placed)).toEqual([]);
    // And it is a dodge rather than the elbow: the three-run route is the one
    // that crosses here.
    expect(routeOf(placed, '010', '030').length).toBeGreaterThan(4);
  });

  it('goes left of everything when the rows in between leave no column', () => {
    const placed = placeOnWorkdays(
      layOutGantt(
        planOf({
          rows: [rowAt('010', 0, 2), rowAt('020', 0, 20), rowAt('030', 3, 5)],
          slices: [
            sliceAt('010-dev', '010', 0, 2),
            // The row in between spans the whole chart, so every column from
            // the predecessor's finish to the successor's start is under a bar.
            sliceAt('020-dev', '020', 0, 20),
            sliceAt('030-dev', '030', 3, 5),
          ],
          dependencies: [{ predecessorId: '010', successorId: '030' }],
        }),
      ),
    );

    const route = routeOf(placed, '010', '030');
    // The only clear column is left of the wide bar, and the route takes it —
    // outside the schedule, inside the canvas the panel pads for exactly this.
    expect(Math.min(...route.map((corner) => corner.x))).toBe(-CLEARANCE.approach);
    expect(crossingsIn(placed)).toEqual([]);
  });

  it('every run is horizontal or vertical', () => {
    const route = routeOf(placeOnWorkdays(layOutGantt(a10())), '020', '040');
    expect(
      route.every(
        (corner, index) =>
          index === 0 || corner.x === route[index - 1].x || corner.y === route[index - 1].y,
      ),
    ).toBe(true);
  });

  it('arrives at the successor’s start from its left, so the head points right', () => {
    const placed = placeOnWorkdays(layOutGantt(a10()));
    for (const arrow of placed.arrows) {
      const route = routeOf(placed, arrow.predecessorId, arrow.successorId);
      const last = route[route.length - 1];
      const before = route[route.length - 2];
      expect([last.x, last.y]).toEqual([arrow.toX, arrow.toRowIndex + 0.5]);
      expect(before.y).toBe(last.y);
      expect(before.x).toBeLessThan(last.x);
    }
  });
});

describe('the invariant over a sweep of generated plans', () => {
  /**
   * The panel's two numbers again — see the describe above; the sweep is a
   * second reading of the same promise and takes the same clearance.
   */
  const CLEARANCE = { approach: 10 / 28, barInset: 0.18 };

  /**
   * The same plans on every run: a linear congruential step, seeded per plan.
   *
   * Not `Math.random`: a sweep that finds a fault nobody can reproduce is a
   * sweep that gets deleted. The seed is the plan's index, so a failure names
   * the plan that produced it.
   */
  const numbersFrom = (seed: number): ((below: number) => number) => {
    let state = seed * 2654435761 + 1;
    return (below) => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return Math.floor((state / 4294967296) * below);
    };
  };

  /**
   * A small plan with a schedule that hangs together: three to seven leaves,
   * one or two roles each, some of them unestimated, dependencies that only
   * ever point backwards through the build order — and then the **rows
   * shuffled**, so an arrow is as likely to climb the chart as to descend it.
   *
   * Deliberately its own little engine rather than a fixture: what is being
   * swept is the router's promise on shapes nobody wrote down, and the two
   * facts it rests on — a row's earliest start is its first slice's, and an
   * arrow leaves the anchor's finish — are the two this builder keeps.
   */
  const generatedPlan = (seed: number): GanttPlan => {
    const next = numbersFrom(seed);
    const leafCount = 3 + next(5);
    const ids = Array.from({ length: leafCount }, (_, index) => `0${String(index + 1)}0`);
    const slices: GanttSlice[] = [];
    const rows: GanttRow[] = [];
    const dependencies: { predecessorId: string; successorId: string }[] = [];
    const anchorFinish = new Map<string, number>();
    const finishOf = new Map<string, number>();

    for (const [index, id] of ids.entries()) {
      let start = 0;
      for (const earlier of ids.slice(0, index)) {
        if (next(3) !== 0) continue;
        dependencies.push({ predecessorId: earlier, successorId: id });
        start = Math.max(start, anchorFinish.get(earlier) ?? 0);
      }
      let cursor = start;
      const own: GanttSlice[] = [];
      for (const roleId of next(2) === 0 ? ['dev'] : ['dev', 'qa']) {
        const estimated = next(4) !== 0;
        const duration = estimated ? 1 + next(4) : 0;
        own.push(
          sliceAt(`${id}-${roleId}`, id, cursor, cursor + duration, {
            roleId,
            estimated,
            duration,
          }),
        );
        cursor += duration;
      }
      const anchor = own.find((slice) => slice.estimated) ?? own[own.length - 1];
      anchorFinish.set(id, anchor.earliestFinish);
      finishOf.set(id, cursor);
      slices.push(...own);
      rows.push(rowAt(id, start, cursor));
    }

    // The shuffle is the point: the payload's order is the tree's, and a plan
    // whose rows all descend would never route an arrow upwards.
    for (let index = rows.length - 1; index > 0; index -= 1) {
      const swap = next(index + 1);
      [rows[index], rows[swap]] = [rows[swap], rows[index]];
    }
    return planOf({ rows, slices, dependencies });
  };

  /** Where a bar is painted, as the describe above reads it. */
  const rectOf = (placed: PlacedBar) => ({
    left: placed.x,
    right: placed.x + placed.width,
    top: placed.bar.rowIndex + CLEARANCE.barInset,
    bottom: placed.bar.rowIndex + 1 - CLEARANCE.barInset,
  });

  const runsInside = (
    from: { x: number; y: number },
    to: { x: number; y: number },
    rect: { left: number; right: number; top: number; bottom: number },
  ): boolean => {
    const spans = (low: number, high: number, one: number, other: number): boolean =>
      Math.min(one, other) < high && Math.max(one, other) > low;
    if (from.x === to.x) {
      return (
        from.x > rect.left && from.x < rect.right && spans(rect.top, rect.bottom, from.y, to.y)
      );
    }
    if (from.y === to.y) {
      return (
        from.y > rect.top && from.y < rect.bottom && spans(rect.left, rect.right, from.x, to.x)
      );
    }
    throw new Error('a route ran diagonally');
  };

  /**
   * The router this change replaced, kept here as the sweep's own control.
   *
   * It is what makes the sweep a check that can fail: run the same plans
   * through it and the crossings come back in the hundreds, so a green sweep is
   * evidence about the router rather than about the generator having produced
   * nothing worth crossing. See `verify.md`.
   */
  const routeAsItWas = (arrow: PlacedArrow): { x: number; y: number }[] => {
    const { approach, barInset } = CLEARANCE;
    const fromY = arrow.fromRowIndex + 0.5;
    const toY = arrow.toRowIndex + 0.5;
    const turn = arrow.toX - approach;
    const crossing =
      arrow.toRowIndex > arrow.fromRowIndex
        ? arrow.fromRowIndex + 1 - barInset / 2
        : arrow.fromRowIndex + barInset / 2;
    return arrow.toX - arrow.fromX >= 2 * approach
      ? [
          { x: arrow.fromX, y: fromY },
          { x: turn, y: fromY },
          { x: turn, y: toY },
          { x: arrow.toX, y: toY },
        ]
      : [
          { x: arrow.fromX, y: fromY },
          { x: arrow.fromX + approach, y: fromY },
          { x: arrow.fromX + approach, y: crossing },
          { x: turn, y: crossing },
          { x: turn, y: toY },
          { x: arrow.toX, y: toY },
        ];
  };

  /** Every crossing the given router draws on the given placed chart. */
  const crossingsUnder = (
    placed: PlacedGantt,
    route_: (arrow: PlacedArrow, drawn: PlacedBar[]) => { x: number; y: number }[],
  ): string[] => {
    const drawn = placed.bars.filter(({ bar }) => bar.estimated);
    const found: string[] = [];
    for (const arrow of placed.arrows) {
      const route = route_(arrow, drawn);
      for (const [index, corner] of route.entries()) {
        if (index === 0) continue;
        for (const bar of drawn) {
          if (runsInside(route[index - 1], corner, rectOf(bar))) {
            found.push(`${arrow.predecessorId}->${arrow.successorId} crosses ${bar.bar.sliceId}`);
          }
        }
      }
    }
    return found;
  };

  const PLAN_COUNT = 400;

  const sweep = (
    place: (chart: ReturnType<typeof layOutGantt>) => PlacedGantt,
    route_: (arrow: PlacedArrow, drawn: PlacedBar[]) => { x: number; y: number }[],
  ): { arrows: number; crossings: string[]; plansWithArrows: number } => {
    let arrows = 0;
    let plansWithArrows = 0;
    const crossings: string[] = [];
    for (let seed = 1; seed <= PLAN_COUNT; seed += 1) {
      const placed = place(layOutGantt(generatedPlan(seed)));
      arrows += placed.arrows.length;
      if (placed.arrows.length > 0) plansWithArrows += 1;
      for (const crossing of crossingsUnder(placed, route_))
        crossings.push(`#${String(seed)} ${crossing}`);
    }
    return { arrows, crossings, plansWithArrows };
  };

  it('draws no arrow through a bar, on 400 plans on the workday axis', () => {
    const swept = sweep(placeOnWorkdays, (arrow, drawn) => routeArrow(arrow, drawn, CLEARANCE));

    // Proof, and the reason this is not a check that cannot fail: the same 400
    // plans under the router this replaced. `expected 0 to be 0` is what a
    // sweep over an empty generator would say, so the control is asserted to
    // find crossings before the router is asserted to find none.
    const control = sweep(placeOnWorkdays, routeAsItWas);
    expect(control.crossings.length).toBeGreaterThan(20);
    expect(swept.crossings).toEqual([]);
    // And the sweep is not measuring an empty chart: most of the plans hold
    // arrows, and there are hundreds of them.
    expect(swept.arrows).toBeGreaterThan(400);
    expect(swept.plansWithArrows).toBeGreaterThan(PLAN_COUNT / 2);
  });

  it('draws no arrow through a bar, on the same plans placed on a calendar', () => {
    const onCalendar = (chart: ReturnType<typeof layOutGantt>): PlacedGantt =>
      placeOnCalendar(chart, '2026-06-01');
    const swept = sweep(onCalendar, (arrow, drawn) => routeArrow(arrow, drawn, CLEARANCE));

    // The weekends widen every bar the descent has to clear, so this is a
    // different sweep and not the same one twice: its control finds crossings
    // the workday one does not.
    const control = sweep(onCalendar, routeAsItWas);
    expect(control.crossings.length).toBeGreaterThan(20);
    expect(swept.crossings).toEqual([]);
    expect(swept.arrows).toBeGreaterThan(400);
  });
});

describe('the waits that were not drawn', () => {
  /**
   * `strip` → `sand`, with a hand-off and a pool wait beside it, so one fixture
   * can lose each kind of link in turn by taking a row off screen.
   *
   * The slices stay in the payload whatever the rows do: that is the shape a
   * narrowed plan actually arrives in — be-01 schedules the whole plan and the
   * screen decides which rows of it to draw (`wbs-table.tsx`).
   */
  const onPlatform = { team: { state: 'named', name: 'Platform' } as const };
  const threeKinds = (parts: Partial<GanttPlan> = {}): GanttPlan =>
    planOf({
      // Every row on a named pool, because the capacity-floored slice below
      // asks its row which team is holding it up and refuses a row with none.
      rows: [
        rowAt('strip', 0, 3, onPlatform),
        rowAt('sand', 3, 5, onPlatform),
        rowAt('wax', 5, 7, onPlatform),
      ],
      slices: [
        sliceAt('strip-dev', 'strip', 0, 3, { personId: 'kat' }),
        sliceAt('sand-dev', 'sand', 3, 5, {
          personId: 'kat',
          boundBy: 'person',
          resourcePredecessorId: 'strip-dev',
        }),
        sliceAt('wax-dev', 'wax', 5, 7, {
          boundBy: 'capacity',
          resourcePredecessorId: 'sand-dev',
          capacityPredecessorIds: ['sand-dev'],
        }),
      ],
      dependencies: [{ predecessorId: 'strip', successorId: 'wax' }],
      ...parts,
    });

  it('counts nothing while every row is on screen', () => {
    const chart = layOutGantt(threeKinds());

    expect(chart.droppedLinks).toEqual({ dependencies: 0, personLinks: 0, capacityLinks: 0 });
    expect(droppedLinkWords(chart.droppedLinks)).toBeNull();
  });

  it('counts each kind of wait whose other end the screen is not showing', () => {
    // `strip` is off screen: the dependency onto `wax` loses its predecessor
    // and Kat's hand-off onto `sand` loses the work she was finishing.
    const chart = layOutGantt(
      threeKinds({ rows: [rowAt('sand', 3, 5, onPlatform), rowAt('wax', 5, 7, onPlatform)] }),
    );

    expect(chart.arrows).toEqual([]);
    expect(chart.personLinks).toEqual([]);
    expect(chart.droppedLinks).toEqual({ dependencies: 1, personLinks: 1, capacityLinks: 0 });
  });

  it('counts a pool wait onto a row that is not drawn', () => {
    const chart = layOutGantt(
      threeKinds({ rows: [rowAt('strip', 0, 3, onPlatform), rowAt('wax', 5, 7, onPlatform)] }),
    );

    expect(chart.capacityLinks).toEqual([]);
    expect(chart.droppedLinks.capacityLinks).toBe(1);
  });

  /**
   * The count is about what a reader can see missing, which is why neither end
   * being drawn is not counted: no bar on this chart lost a mark, and a number
   * for a wait between two rows nobody is looking at is a number nobody can act
   * on.
   */
  it('counts nothing for a link with neither end on screen', () => {
    // Both ends of Kat's hand-off and of the stored edge are off screen; the
    // one row drawn has no wait of its own.
    const chart = layOutGantt(
      planOf({
        rows: [rowAt('wax', 5, 7)],
        slices: [
          sliceAt('strip-dev', 'strip', 0, 3, { personId: 'kat' }),
          sliceAt('sand-dev', 'sand', 3, 5, {
            personId: 'kat',
            boundBy: 'person',
            resourcePredecessorId: 'strip-dev',
          }),
          sliceAt('wax-dev', 'wax', 5, 7),
        ],
        dependencies: [{ predecessorId: 'strip', successorId: 'sand' }],
      }),
    );

    expect(chart.droppedLinks).toEqual({ dependencies: 0, personLinks: 0, capacityLinks: 0 });
  });

  it('counts the edge that leaves a shown row for a hidden successor', () => {
    // The direction the old `dependencies` list could not even carry: `strip`
    // is drawn and its successor is not, so its bar loses an arrow.
    const chart = layOutGantt(
      threeKinds({ rows: [rowAt('strip', 0, 3, onPlatform), rowAt('sand', 3, 5, onPlatform)] }),
    );

    expect(chart.arrows).toEqual([]);
    expect(chart.droppedLinks.dependencies).toBe(1);
  });

  it('says what was dropped, kind by kind, and how to see it', () => {
    expect(droppedLinkWords({ dependencies: 2, personLinks: 1, capacityLinks: 3 })).toBe(
      'Not drawn: 6 waits whose other end this filter is hiding — 2 stored dependencies, ' +
        '1 person hand-off, 3 waits for a team to free somebody. Clear the filter to see them.',
    );
  });

  it('says one wait in the singular, and names only the kind it has', () => {
    expect(droppedLinkWords({ dependencies: 1, personLinks: 0, capacityLinks: 0 })).toBe(
      'Not drawn: 1 wait whose other end this filter is hiding — 1 stored dependency. ' +
        'Clear the filter to see it.',
    );
  });
});

describe('what holds a row’s start, for the table', () => {
  it('gives every leaf the floor of the slice that starts when the row does', () => {
    // Dev runs 0→2 and QA 2→5, so the row starts when Dev does and QA's own
    // floor — the row waiting on itself — is not the row's answer.
    const floors = startFloorByRow(
      planOf({
        rows: [rowAt('020', 0, 5)],
        slices: [
          sliceAt('020-dev', '020', 0, 2),
          sliceAt('020-qa', '020', 2, 5, { roleId: 'qa', boundBy: 'roleOrder' }),
        ],
      }),
    );

    expect(floors.get('020')).toBe('Starts with the project');
  });

  it('says a dependency floor in the chart’s words, not the End column’s', () => {
    const floors = startFloorByRow(
      planOf({
        rows: [rowAt('030', 0, 6), rowAt('020', 3, 8)],
        slices: [
          sliceAt('030-dev', '030', 0, 3),
          sliceAt('020-dev', '020', 3, 8, { boundBy: 'predecessor' }),
        ],
        dependencies: [{ predecessorId: '030', successorId: '020' }],
      }),
    );

    expect(floors.get('020')).toBe('Waits for a dependency’s first estimated role');
  });

  it('names the person a row is queued behind, and what they were finishing', () => {
    const floors = startFloorByRow(
      planOf({
        rows: [rowAt('010', 0, 2, { name: 'Strip' }), rowAt('020', 2, 4)],
        slices: [
          sliceAt('010-dev', '010', 0, 2, { personId: 'kat' }),
          sliceAt('020-dev', '020', 2, 4, {
            personId: 'kat',
            boundBy: 'person',
            resourcePredecessorId: '010-dev',
          }),
        ],
      }),
    );

    expect(floors.get('020')).toBe('Kat — after Strip (Dev)');
  });

  it('names the pool a row is short of, how many it needs and who freed them', () => {
    const floors = startFloorByRow(
      planOf({
        rows: [
          rowAt('010', 0, 2, { name: 'Strip' }),
          rowAt('020', 2, 4, { team: { state: 'named', name: 'Growth squad' } }),
        ],
        slices: [
          sliceAt('010-dev', '010', 0, 2),
          sliceAt('020-dev', '020', 2, 4, {
            boundBy: 'capacity',
            resourcePredecessorId: '010-dev',
            capacityPredecessorIds: ['010-dev'],
          }),
        ],
      }),
    );

    expect(floors.get('020')).toBe('Waits for Growth squad to free a person — after Strip (Dev)');
  });

  it('has nothing to say about a parent, which holds no slices', () => {
    const floors = startFloorByRow(
      planOf({
        rows: [rowAt('000', 0, 5, { leaf: false }), rowAt('010', 0, 5, { depth: 1 })],
        slices: [sliceAt('010-dev', '010', 0, 5)],
      }),
    );

    expect(floors.has('000')).toBe(false);
    expect(floors.get('010')).toBe('Starts with the project');
  });

  it('skips the row it cannot explain and keeps every row it can', () => {
    // A capacity floor with no team to be short of: `layOutGantt` refuses this
    // payload whole and the chart's error boundary says so. The table cannot
    // afford that, so the broken row loses its sentence alone.
    const plan = planOf({
      rows: [rowAt('010', 0, 2), rowAt('020', 2, 4)],
      slices: [
        sliceAt('010-dev', '010', 0, 2),
        sliceAt('020-dev', '020', 2, 4, {
          boundBy: 'capacity',
          resourcePredecessorId: '010-dev',
          capacityPredecessorIds: ['010-dev'],
        }),
      ],
    });

    expect(() => layOutGantt(plan)).toThrow(GanttDataError);
    const floors = startFloorByRow(plan);
    expect(floors.has('020')).toBe(false);
    expect(floors.get('010')).toBe('Starts with the project');
  });

  it('skips a row whose slice is under a role the plan does not list', () => {
    const floors = startFloorByRow(
      planOf({
        rows: [rowAt('010', 0, 2), rowAt('020', 0, 2)],
        slices: [
          sliceAt('010-dev', '010', 0, 2),
          sliceAt('020-ops', '020', 0, 2, { roleId: 'ops' }),
        ],
      }),
    );

    expect(floors.has('020')).toBe(false);
    expect(floors.get('010')).toBe('Starts with the project');
  });
});
