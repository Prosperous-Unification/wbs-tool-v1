import { describe, expect, it } from 'vitest';

import type { GanttPlan, GanttRow, GanttSlice } from './gantt-geometry';
import { type MermaidPlan, planToMermaid, SYNTHETIC_ORIGIN } from './plan-mermaid';

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
  maxParallel: 1,
  team: { state: 'none' },
  trioByRole: new Map(),
  waitsFor: [],
  ...extras,
});

/** A scheduled slice over these workdays, floored by the project start and under `dev`. */
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
  width: 1,
  effort: earliestFinish - earliestStart,
  capacityPredecessorIds: [],
  ...extras,
});

/** The flat tree a fixture's rows imply — every row at the root, which is what `rowAt` builds. */
const treeFrom = (rows: readonly GanttRow[]): { id: string; parentId: string | null }[] =>
  rows.map((row) => ({ id: row.id, parentId: null }));

const planOf = (
  rows: readonly GanttRow[],
  slices: readonly GanttSlice[],
  extras: Partial<GanttPlan> = {},
): GanttPlan => ({
  rows,
  slices,
  dependencies: [],
  tree: treeFrom(rows),
  roles: [
    { id: 'dev', name: 'Dev' },
    { id: 'qa', name: 'QA' },
  ],
  personNames: new Map([
    ['ada', 'ada'],
    ['bo', 'Bo'],
  ]),
  ...extras,
});

/** A project on a calendar from Monday 1 June 2026, unless a case says otherwise. */
const doc = (over: Partial<MermaidPlan> = {}): MermaidPlan => ({
  projectName: 'Rewire the shed',
  generatedAt: '2026-08-14T09:15:00.000Z',
  startDate: '2026-06-01',
  scheduleError: null,
  ...over,
});

/** The lines of the fenced diagram, without the fence, the comments or the legend. */
function diagramOf(text: string): string[] {
  const opened = text.split('\n');
  const start = opened.indexOf('gantt');
  const end = opened.indexOf('```', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return opened.slice(start, end);
}

/** Every task line of the diagram, as Mermaid's grammar splits one: the name, then the rest. */
function tasksOf(text: string): { name: string; data: string }[] {
  return diagramOf(text)
    .filter(
      (line) =>
        line.includes(':') &&
        !line.trimStart().startsWith('section') &&
        // The comment block sits inside the diagram and its prose has colons in
        // it. Mermaid reads a `%%` line as a comment and so does this.
        !line.trimStart().startsWith('%%'),
    )
    .map((line) => {
      const at = line.indexOf(':');
      return { name: line.slice(0, at).trim(), data: line.slice(at + 1).trim() };
    });
}

/** The legend under the fence — everything after the closing fence. */
function legendOf(text: string): string {
  const closed = text.lastIndexOf('```');
  return text.slice(closed + 3);
}

describe('planToMermaid', () => {
  it('puts one section per work item and one task per role slice, in the chart’s own order', () => {
    const rows = [rowAt('010', 0, 3), rowAt('020', 3, 5)];
    const slices = [
      sliceAt('s-010-dev', '010', 0, 2),
      sliceAt('s-010-qa', '010', 2, 3, { roleId: 'qa' }),
      sliceAt('s-020-dev', '020', 3, 5),
    ];
    const text = planToMermaid(planOf(rows, slices), doc());
    expect(diagramOf(text).filter((line) => line.trimStart().startsWith('section'))).toEqual([
      '    section 010 010',
      '    section 020 020',
    ]);
    expect(tasksOf(text).map((task) => task.name)).toEqual([
      'Dev · unassigned',
      'QA · unassigned',
      'Dev · unassigned',
    ]);
  });

  it('declares the format Mermaid needs and excludes the weekends the schedule already skips', () => {
    const text = planToMermaid(planOf([rowAt('010', 0, 2)], [sliceAt('s', '010', 0, 2)]), doc());
    expect(diagramOf(text).filter((line) => !line.trimStart().startsWith('%%')).slice(0, 5)).toEqual([
      'gantt',
      '    title Rewire the shed',
      '    dateFormat YYYY-MM-DD',
      '    axisFormat %d %b',
      '    excludes weekends',
    ]);
  });

  it('dates a bar from the plan’s own calendar, with the weekend between two spans', () => {
    // Four workdays from Monday 1 June is the Thursday; the next slice starts on
    // the Friday and runs one day past the weekend, so it stops on the Tuesday.
    const rows = [rowAt('010', 0, 4), rowAt('020', 4, 6)];
    const slices = [sliceAt('a', '010', 0, 4), sliceAt('b', '020', 4, 6)];
    const text = planToMermaid(planOf(rows, slices), doc());
    expect(tasksOf(text).map((task) => task.data)).toEqual([
      't1, 2026-06-01, 2026-06-05',
      't2, 2026-06-05, 2026-06-09',
    ]);
  });

  it('rounds a fractional span outward, so no bar is drawn shorter than the work in it', () => {
    // Half a day of work, which is a bar of no whole days at all. Rounding the
    // finish down would draw it as a point and say the work is not there.
    const slices = [
      sliceAt('half', '010', 0, 0.5, { duration: 0.5, effort: 1, width: 2 }),
      sliceAt('rest', '010', 0.5, 2, { roleId: 'qa', duration: 1.5, effort: 1.5 }),
    ];
    const text = planToMermaid(planOf([rowAt('010', 0, 2)], slices), doc());
    expect(tasksOf(text).map((task) => task.data)).toEqual([
      't1, 2026-06-01, 2026-06-02',
      't2, 2026-06-01, 2026-06-03',
    ]);
  });

  it('marks the critical path with Mermaid’s own crit tag, and marks nothing else', () => {
    const slices = [
      sliceAt('a', '010', 0, 2, { critical: true }),
      sliceAt('b', '010', 2, 3, { roleId: 'qa', float: 4 }),
    ];
    const text = planToMermaid(planOf([rowAt('010', 0, 3)], slices), doc());
    expect(tasksOf(text).map((task) => task.data)).toEqual([
      'crit, t1, 2026-06-01, 2026-06-03',
      't2, 2026-06-03, 2026-06-04',
    ]);
  });

  it('draws an unestimated slice as a milestone, never as the chart’s two assumed days', () => {
    const slices = [
      sliceAt('a', '010', 0, 2),
      sliceAt('b', '010', 2, 2, { roleId: 'qa', estimated: false, duration: 0, effort: 0 }),
    ];
    const text = planToMermaid(planOf([rowAt('010', 0, 2)], slices), doc());
    const [, unestimated] = tasksOf(text);
    expect(unestimated).toEqual({
      name: 'QA · unassigned · not estimated',
      data: 'milestone, t2, 2026-06-03, 0d',
    });
  });

  it('tells an estimated zero apart from an unestimated blank', () => {
    const slices = [sliceAt('a', '010', 0, 0, { duration: 0, effort: 0 })];
    const text = planToMermaid(planOf([rowAt('010', 0, 0)], slices), doc());
    expect(tasksOf(text)).toEqual([
      { name: 'Dev · unassigned · 0 days', data: 'milestone, t1, 2026-06-01, 0d' },
    ]);
  });

  it('names who is on a bar, and how many of them ran at once', () => {
    const slices = [
      sliceAt('a', '010', 0, 2, { personId: 'ada' }),
      sliceAt('b', '010', 2, 3, { roleId: 'qa', width: 3, effort: 3, duration: 1 }),
    ];
    const text = planToMermaid(planOf([rowAt('010', 0, 3)], slices), doc());
    expect(tasksOf(text).map((task) => task.name)).toEqual([
      'Dev · ada',
      'QA · unassigned · 3 at once',
    ]);
  });

  it('carries the pool and the priority into the section title, because a gantt has no other channel', () => {
    const rows = [
      rowAt('010', 0, 2, { name: 'Strip', priority: 10, team: { state: 'named', name: 'Platform' } }),
    ];
    const text = planToMermaid(planOf(rows, [sliceAt('a', '010', 0, 2)]), doc());
    expect(diagramOf(text)).toContain('    section 010 Strip · Platform · P10');
  });

  it('escapes a colon in a name, because Mermaid splits the task line on the first one', () => {
    // Proof that this matters, measured against Mermaid 11.16.1's own parser:
    // `Dev: build :t1, …` reads back as `{task: 'Dev', id: 'build :t1'}` — the
    // diagram does not fail, it quietly means something else.
    const rows = [rowAt('010', 0, 2, { name: 'Payments: phase two' })];
    const text = planToMermaid(planOf(rows, [sliceAt('a', '010', 0, 2)]), doc());
    expect(diagramOf(text)).toContain('    section 010 Payments- phase two');
    expect(tasksOf(text)).toEqual([{ name: 'Dev · unassigned', data: 't1, 2026-06-01, 2026-06-03' }]);
  });

  it('gives an unnamed row the tree’s own words, because Mermaid refuses a nameless section', () => {
    const rows = [rowAt('010', 0, 2, { name: '' })];
    const text = planToMermaid(planOf(rows, [sliceAt('a', '010', 0, 2)]), doc());
    expect(diagramOf(text)).toContain('    section 010 (unnamed)');
  });

  it('pins a plan that is not on a calendar to a Monday, and says so twice', () => {
    const text = planToMermaid(
      planOf([rowAt('010', 0, 2)], [sliceAt('a', '010', 0, 2)]),
      doc({ startDate: null }),
    );
    expect(text).toContain(
      `    %% This plan is not on a calendar. Day zero is drawn as ${SYNTHETIC_ORIGIN}, a Monday,`,
    );
    expect(tasksOf(text).map((task) => task.data)).toEqual(['t1, 2000-01-03, 2000-01-05']);
  });

  it('says nothing about a synthetic origin on a plan that has a real one', () => {
    const text = planToMermaid(planOf([rowAt('010', 0, 2)], [sliceAt('a', '010', 0, 2)]), doc());
    expect(text).not.toContain('not on a calendar');
  });

  it('is byte-identical twice over the same plan', () => {
    const rows = [
      rowAt('010', 0, 2, { team: { state: 'named', name: 'Platform' }, priority: 3 }),
      rowAt('020', 2, 4),
    ];
    const slices = [
      sliceAt('a', '010', 0, 2, { personId: 'bo' }),
      sliceAt('b', '020', 2, 4, { personId: 'ada', critical: true }),
    ];
    const plan = planOf(rows, slices, {
      dependencies: [{ predecessorId: '010', successorId: '020' }],
    });
    expect(planToMermaid(plan, doc())).toBe(planToMermaid(plan, doc()));
  });

  it('carries the timestamp it was given into the comment block', () => {
    const text = planToMermaid(planOf([rowAt('010', 0, 2)], [sliceAt('a', '010', 0, 2)]), doc());
    expect(text).toContain(
      '    %% Rewire the shed — exported from the WBS tool at 2026-08-14T09:15:00.000Z.',
    );
  });

  describe('the legend', () => {
    it('lists every stored dependency, because Mermaid’s gantt draws no arrows', () => {
      const rows = [rowAt('010', 0, 2, { name: 'Strip' }), rowAt('020', 2, 4, { name: 'Fit' })];
      const plan = planOf(rows, [sliceAt('a', '010', 0, 2), sliceAt('b', '020', 2, 4)], {
        dependencies: [{ predecessorId: '010', successorId: '020' }],
      });
      expect(legendOf(planToMermaid(plan, doc()))).toContain('  - 020 Fit waits for 010 Strip');
    });

    it('quotes the chart’s own words for a slice a pool held up', () => {
      const rows = [
        rowAt('010', 0, 2, { name: 'Strip' }),
        rowAt('020', 2, 4, { name: 'Fit', team: { state: 'named', name: 'Platform' } }),
      ];
      const slices = [
        sliceAt('a', '010', 0, 2),
        sliceAt('b', '020', 2, 4, {
          boundBy: 'capacity',
          resourcePredecessorId: 'a',
          capacityPredecessorIds: ['a'],
        }),
      ];
      // The chart's own sentence, verbatim, down to the bare name: `layOutGantt`
      // builds its floor words from `row.name` alone, so the predecessor is
      // `Strip` here where the line's own row is `020 Fit`. Quoted rather than
      // re-derived — the document and the bar's hover card must not be two
      // readings of one wait — and the asymmetry is recorded in design.md D9.
      expect(legendOf(planToMermaid(planOf(rows, slices), doc()))).toContain(
        '  - 020 Fit · Dev — Waits for Platform to free a person — after Strip (Dev)',
      );
    });

    it('quotes the chart’s own words for a slice a busy assignee held up', () => {
      const rows = [rowAt('010', 0, 2, { name: 'Strip' }), rowAt('020', 2, 4, { name: 'Fit' })];
      const slices = [
        sliceAt('a', '010', 0, 2, { personId: 'ada' }),
        sliceAt('b', '020', 2, 4, {
          personId: 'ada',
          boundBy: 'person',
          resourcePredecessorId: 'a',
        }),
      ];
      expect(legendOf(planToMermaid(planOf(rows, slices), doc()))).toContain(
        '  - 020 Fit · Dev — ada — after Strip (Dev)',
      );
    });

    it('lists every start-no-earlier-than date, which the diagram has no mark for', () => {
      // Workday 8, deliberately past the first weekend: workday 8 from Monday
      // 1 June is Thursday the 11th, and a date read off the offset as if it
      // were a calendar day would say Tuesday the 9th. A fixture inside the
      // first week cannot tell the two readings apart at all.
      const rows = [rowAt('010', 0, 2, { name: 'Strip', notBeforeOffset: 8 })];
      expect(legendOf(planToMermaid(planOf(rows, [sliceAt('a', '010', 0, 2)]), doc()))).toContain(
        '  - 010 Strip — not before 2026-06-11',
      );
    });

    it('says the plan holds none rather than dropping the bullet, which would read as drawn', () => {
      const legend = legendOf(
        planToMermaid(planOf([rowAt('010', 0, 2)], [sliceAt('a', '010', 0, 2)]), doc()),
      );
      expect(legend).toContain(
        "- **Dependency arrows.** Mermaid's gantt draws none. This plan stores none either.",
      );
      expect(legend).toContain('- **Start-no-earlier-than dates.** No row in this plan carries one.');
      expect(legend).toContain('- **Nothing at all draws:**');
    });
  });

  describe('with nothing to draw', () => {
    it('draws no diagram at all for a plan whose dependencies run in a circle', () => {
      const text = planToMermaid(
        planOf([rowAt('010', 0, 0)], [sliceAt('a', '010', 0, 0)]),
        doc({ scheduleError: 'cycle' }),
      );
      expect(text).not.toContain('gantt');
      expect(text).toContain('These dependencies run in a circle');
    });

    it('draws no diagram for a plan nothing has scheduled yet', () => {
      const plan = planOf([rowAt('010', 0, 0)], [], {
        dependencies: [{ predecessorId: '010', successorId: '010' }],
      });
      const text = planToMermaid(plan, doc());
      expect(text).not.toContain('gantt');
      expect(text).toContain('no scheduled work in it yet');
    });
  });
});
