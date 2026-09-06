import { DEFAULT_PRIORITY_BANDS } from '@wbs/domain/priority-band';
import type { Mermaid } from 'mermaid';
import { beforeAll, describe, expect, it } from 'vitest';

import { sliceView } from '@/testing/views';

import {
  type ExportRow,
  type ExportSlice,
  markdownTableLines,
  type PlanExport,
} from './plan-export';
import {
  DEFAULT_SECTION_MODE,
  isSectionMode,
  NO_SCHEDULE_TO_DRAW,
  NOT_ON_A_CALENDAR,
  NOTHING_PLACED,
  planToMermaid,
  planToMermaidDocument,
  SECTION_MODES,
  type SectionMode,
} from './plan-mermaid';

const DEV = { id: 'step-dev', name: 'Dev' };
const QA = { id: 'step-qa', name: 'QA' };

/**
 * The plan starts on Tuesday 1 September 2026, so the workdays are
 * `0` Tue 1st, `1` Wed 2nd, `2` Thu 3rd, `3` Fri 4th, `4` Mon 7th, `5` Tue 8th,
 * `6` Wed 9th. Every date asserted below is one of those, counted by hand — an
 * expectation computed from `addWorkdays` would pass under a writer that
 * mis-read the scale in exactly the way `addWorkdays` does.
 */
const START = '2026-09-01';

const row = (over: Partial<ExportRow> & Pick<ExportRow, 'id' | 'number'>): ExportRow =>
  Object.assign(
    {
      parentId: null,
      maxParallel: 1,
      name: '',
      notes: '',
      tagIds: [],
      serviceIds: [],
      rolledUp: false,
      teamIds: [],
      estimates: {},
      finalDays: {},
      finalTotal: 0,
      dependsOn: [],
      startNoEarlierThan: null,
      priority: null,
      dates: null,
      schedule: { earliestStart: 0, earliestFinish: 0, float: 0, critical: false },
      assignees: {},
      doesEveryStep: null,
      ...over,
    },
    over,
  );

/** A placed slice, spelled out in full: `ExportSlice` is be-01's `SliceView`. */
const slice = (over: Partial<ExportSlice> & Pick<ExportSlice, 'id' | 'workItemId'>): ExportSlice =>
  sliceView({
    stepId: DEV.id,
    personId: null,
    duration: 3,
    estimated: true,
    earliestStart: 0,
    earliestFinish: 3,
    latestStart: 0,
    latestFinish: 3,
    float: 0,
    critical: false,
    boundBy: 'projectStart',
    resourcePredecessorId: null,
    width: 1,
    effort: 3,
    capacityPredecessorIds: [],
    lateBy: null,
    ...over,
  });

const plan = (over: Partial<PlanExport> = {}): PlanExport =>
  Object.assign(
    {
      projectName: 'Rewire the shed',
      generatedAt: '2026-09-01T09:15:00.000Z',
      method: 'pert',
      startDate: START,
      scheduleError: null,
      steps: [DEV, QA],
      teams: [{ id: 'team-billing', name: 'Billing, Ltd' }],
      priorityBands: DEFAULT_PRIORITY_BANDS,
      people: [
        { id: 'person-ada', name: 'Ada' },
        { id: 'person-bo', name: 'Bo' },
      ],
      tags: [],
      services: [],
      rows: [row({ id: 'a', number: '010', name: 'Strip' })],
      slices: [slice({ id: 'slice-a', workItemId: 'a' })],
    },
    over,
  );

/** The diagram, or the failure of a test that expected one. */
function drawn(document: PlanExport, sectionMode: SectionMode = DEFAULT_SECTION_MODE): string {
  const result = planToMermaid(document, sectionMode);
  if (!result.drawn) throw new Error(`expected a diagram, got a refusal: ${result.refusal}`);
  return result.text;
}

/** The lines of the diagram with their indent taken off, which is what assertions read. */
function lines(document: PlanExport, sectionMode: SectionMode = DEFAULT_SECTION_MODE): string[] {
  return drawn(document, sectionMode)
    .split('\n')
    .map((line) => line.trim());
}

describe('the refusals', () => {
  it('refuses a plan that is not on a calendar, in words', () => {
    // The one refusal the brief argued for. A Mermaid gantt has no `day 3`, and
    // an invented epoch would put dates nobody agreed to in a document that
    // outlives the screen.
    const result = planToMermaid(plan({ startDate: null }));
    expect(result).toEqual({ drawn: false, refusal: NOT_ON_A_CALENDAR });
    expect(NOT_ON_A_CALENDAR).toContain('Set a start date');
  });

  it('refuses a plan whose dependencies run in a circle', () => {
    expect(planToMermaid(plan({ scheduleError: 'cycle' }))).toEqual({
      drawn: false,
      refusal: NO_SCHEDULE_TO_DRAW,
    });
  });

  it('refuses a plan nothing has been placed in, rather than an empty fence', () => {
    expect(planToMermaid(plan({ slices: [] }))).toEqual({
      drawn: false,
      refusal: NOTHING_PLACED,
    });
  });

  it('puts no diagram in a refusal, so a copy cannot paste one', () => {
    // The refusal names a Mermaid gantt in its own sentence, so the assertion
    // is about the shape rather than about the word: there is no `text` on a
    // refusal at all, which is what makes a caller choose the toast.
    const result = planToMermaid(plan({ startDate: null }));
    expect(result.drawn).toBe(false);
    expect('text' in result).toBe(false);
    expect(JSON.stringify(result)).not.toContain('dateFormat');
  });
});

describe('the header', () => {
  it('opens with gantt and declares the format, the inclusivity and the weekends', () => {
    // `gantt` first and the comment block after the declarations: a `%%` line
    // standing where `gantt` should be is a parse error in the gantt grammar.
    expect(lines(plan()).slice(0, 5)).toEqual([
      'gantt',
      'title Rewire the shed',
      'dateFormat YYYY-MM-DD',
      'inclusiveEndDates',
      'excludes weekends',
    ]);
  });

  it('names the project and when the export was taken, in a comment', () => {
    expect(drawn(plan())).toContain(
      '%% Rewire the shed — exported from the WBS tool at 2026-09-01T09:15:00.000Z.',
    );
  });

  it('says in the fence what the diagram cannot draw', () => {
    const text = drawn(plan());
    expect(text).toContain('%% draw dependency arrows, capacity or hand-off waits, slack');
    expect(text).toContain('Copy as');
  });

  it('titles a nameless project rather than emitting a bare title keyword', () => {
    expect(lines(plan({ projectName: '   ' }))[1]).toBe('title Plan');
  });
});

describe('the dates', () => {
  it('ends a bar on the last day the work is still on', () => {
    // Three workdays from Tuesday the 1st: Tue, Wed, Thu. The end is Thursday
    // the 3rd and not Friday the 4th — `inclusiveEndDates` is what makes
    // Mermaid read it as the last day rather than as the boundary after it.
    expect(lines(plan())).toContain('010 Strip - Dev :s1, 2026-09-01, 2026-09-03');
  });

  it('carries a bar over the weekend the working days skip', () => {
    // Workdays 3 to 6: Friday the 4th, Monday the 7th, Tuesday the 8th. The
    // weekend is inside the span and is drawn by `excludes weekends`, which is
    // cosmetic here precisely because both dates are literal.
    const text = lines(
      plan({ slices: [slice({ id: 's', workItemId: 'a', earliestStart: 3, earliestFinish: 6 })] }),
    );
    expect(text).toContain('010 Strip - Dev :s1, 2026-09-04, 2026-09-08');
  });

  it('rounds a fractional slice outward rather than drawing it short', () => {
    // A slice is `effort / width` workdays and can be a fraction. A day and a
    // half of work occupies two days of the drawing.
    const text = lines(
      plan({
        slices: [
          slice({ id: 's', workItemId: 'a', earliestFinish: 1.5, duration: 1.5, effort: 1.5 }),
        ],
      }),
    );
    expect(text).toContain('010 Strip - Dev :s1, 2026-09-01, 2026-09-02');
  });

  it('never ends a bar before it starts', () => {
    // The clamp. `endOf` reads the *left* limit of a whole workday, so a slice
    // of no length lands its end a day behind its own start without it.
    //
    // Proof: `Math.max(first, …)` in `tasksOf` replaced by the bare
    // `Math.ceil(...) - 1`. Watched red — see verify.md, fault 1.
    const text = lines(
      plan({
        slices: [
          slice({
            id: 's',
            workItemId: 'a',
            earliestStart: 2,
            earliestFinish: 2,
            duration: 0,
            effort: 0,
          }),
        ],
      }),
    );
    expect(text).toContain('010 Strip - Dev - 0 days :milestone, s1, 2026-09-03, 2026-09-03');
  });

  it('begins a plan whose start date is a Saturday on the Monday after it', () => {
    // The chart's own normalisation, inherited rather than repeated: two
    // origins would stand every date here a day or two off the table's.
    const text = lines(plan({ startDate: '2026-09-05' }));
    expect(text).toContain('010 Strip - Dev :s1, 2026-09-07, 2026-09-09');
  });
});

describe('the tasks', () => {
  it('draws one task per slice, in row order and then step order', () => {
    // Payload order is be-01's, and it is not the chart's: the QA slice is
    // listed first here and belongs second.
    const rows = [
      row({ id: 'a', number: '010', name: 'Strip' }),
      row({ id: 'b', number: '020', name: 'Rewire' }),
    ];
    const text = lines(
      plan({
        rows,
        slices: [
          slice({
            id: 's-qa',
            workItemId: 'a',
            stepId: QA.id,
            earliestStart: 3,
            earliestFinish: 4,
          }),
          slice({ id: 's-dev', workItemId: 'a' }),
          slice({ id: 's-b', workItemId: 'b', earliestStart: 4, earliestFinish: 5 }),
        ],
      }),
      // The task lines and nothing else: the comment block carries colons of
      // its own, in the timestamp.
    ).filter((line) => line.includes(', 2026-'));
    expect(text).toEqual([
      '010 Strip - Dev :s1, 2026-09-01, 2026-09-03',
      '010 Strip - QA :s2, 2026-09-04, 2026-09-04',
      '020 Rewire - Dev :s3, 2026-09-07, 2026-09-07',
    ]);
  });

  it('names whoever is on the bar, and says nothing where nobody is', () => {
    const text = lines(
      plan({ slices: [slice({ id: 's', workItemId: 'a', personId: 'person-ada' })] }),
    );
    expect(text).toContain('010 Strip - Dev (Ada) :s1, 2026-09-01, 2026-09-03');
    expect(lines(plan())).toContain('010 Strip - Dev :s1, 2026-09-01, 2026-09-03');
  });

  it('tags the critical path, which is the one mark that maps exactly', () => {
    const text = lines(plan({ slices: [slice({ id: 's', workItemId: 'a', critical: true })] }));
    expect(text).toContain('010 Strip - Dev :crit, s1, 2026-09-01, 2026-09-03');
  });

  it('keeps an unestimated slice apart from one estimated at zero', () => {
    const text = lines(
      plan({
        slices: [
          slice({
            id: 's',
            workItemId: 'a',
            estimated: false,
            duration: 0,
            effort: 0,
            earliestFinish: 0,
          }),
        ],
      }),
    );
    // Never the chart's two-day drawing assumption for an unestimated slice:
    // the chart draws that guess dashed with a `?` beside it, Mermaid has
    // neither mark, and two solid days here would be an estimate this tool
    // invented inside somebody else's document.
    expect(text).toContain(
      '010 Strip - Dev - not estimated :milestone, s1, 2026-09-01, 2026-09-01',
    );
  });

  it('names a work item with no name of its own', () => {
    expect(lines(plan({ rows: [row({ id: 'a', number: '010' })] }))).toContain(
      '010 (unnamed) - Dev :s1, 2026-09-01, 2026-09-03',
    );
  });

  it('names a slice under no step at all', () => {
    expect(lines(plan({ slices: [slice({ id: 's', workItemId: 'a', stepId: null })] }))).toContain(
      '010 Strip - no step :s1, 2026-09-01, 2026-09-03',
    );
  });
});

describe('the sections', () => {
  it('groups a branch under its outermost ancestor, whatever its depth', () => {
    const rows = [
      row({ id: 'a', number: '010', name: 'Strip' }),
      row({ id: 'a1', number: '010.1', name: 'Cables', parentId: 'a' }),
      row({ id: 'a11', number: '010.1.1', name: 'Trunk', parentId: 'a1' }),
      row({ id: 'b', number: '020', name: 'Rewire' }),
    ];
    const text = lines(
      plan({
        rows,
        slices: [
          slice({ id: 's1', workItemId: 'a11' }),
          slice({ id: 's2', workItemId: 'a1', earliestStart: 3, earliestFinish: 4 }),
          slice({ id: 's3', workItemId: 'b', earliestStart: 4, earliestFinish: 5 }),
        ],
      }),
    );
    expect(text.filter((line) => line.startsWith('section'))).toEqual([
      'section 010 Strip',
      'section 020 Rewire',
    ]);
    // The deep row's own number is on its task, which is what carries the
    // outline Mermaid's one flat grouping channel cannot. `s2` and not `s1`:
    // ids run in row order, and `010.1` is above `010.1.1` in the tree.
    expect(text).toContain('010.1.1 Trunk - Dev :s2, 2026-09-01, 2026-09-03');
    expect(text).toContain('010.1 Cables - Dev :s1, 2026-09-04, 2026-09-04');
  });

  it('terminates on a parent chain that runs in a circle', () => {
    // A guard, not a shape: `plan.rows` is every row of a real plan, so the
    // chain always reaches a root. This file is handed a document rather than a
    // tree, and a loop in one would hang the copy button.
    //
    // Proof: the `seen` set in `outermost` removed. Watched red — see
    // verify.md, fault 2, where this test does not fail but times out.
    const rows = [
      row({ id: 'a', number: '010', name: 'Strip', parentId: 'b' }),
      row({ id: 'b', number: '020', name: 'Rewire', parentId: 'a' }),
    ];
    const text = lines(plan({ rows, slices: [slice({ id: 's', workItemId: 'a' })] }));
    expect(text).toContain('section 020 Rewire');
  });
});

describe('the section choice (M3)', () => {
  const A = row({ id: 'a', number: '010', name: 'Strip' });
  const B = row({ id: 'b', number: '020', name: 'Rewire' });
  const C = row({ id: 'c', number: '030', name: 'Test' });

  it('defaults to outline — a caller passing nothing draws exactly what M1 always drew', () => {
    expect(lines(plan())).toEqual(lines(plan(), 'outline'));
  });

  it("groups by step, gathering a step's slices into one section wherever their rows sit, unnamed last", () => {
    // Dev sits on rows a and c with a QA row (b) between them in row order —
    // the shape a row-order-only sort cannot keep as one section. See fault 1,
    // verify.md: with the section's own order struck from the sort, this draws
    // `section Dev` twice with `section QA` between the two halves.
    const text = lines(
      plan({
        rows: [A, B, C],
        slices: [
          // Deliberately out of row order and out of step order in the payload —
          // be-01's order is not the diagram's, same discipline as the M1 tests.
          slice({
            id: 's-a-none',
            workItemId: 'a',
            stepId: null,
            earliestStart: 4,
            earliestFinish: 5,
          }),
          slice({
            id: 's-b-qa',
            workItemId: 'b',
            stepId: QA.id,
            earliestStart: 3,
            earliestFinish: 4,
          }),
          slice({
            id: 's-c-dev',
            workItemId: 'c',
            stepId: DEV.id,
            earliestStart: 4,
            earliestFinish: 5,
          }),
          slice({ id: 's-a-dev', workItemId: 'a', stepId: DEV.id }),
        ],
      }),
      'step',
    );
    expect(text.filter((line) => line.startsWith('section'))).toEqual([
      'section Dev',
      'section QA',
      'section no step',
    ]);
    // Both Dev slices — row a and row c — sit under the one `section Dev`,
    // row a's ahead of row c's, before QA's row-b slice appears at all.
    expect(text.filter((line) => line.includes(', 2026-'))).toEqual([
      '010 Strip - Dev :s1, 2026-09-01, 2026-09-03',
      '030 Test - Dev :s2, 2026-09-07, 2026-09-07',
      '020 Rewire - QA :s3, 2026-09-04, 2026-09-04',
      '010 Strip - no step :s4, 2026-09-07, 2026-09-07',
    ]);
  });

  it('groups by assignee, in the roster order the app already lists people in, unassigned last', () => {
    // Same shape as the step test, one level over: Ada on rows a and c, Bo's
    // row (b) between them.
    const text = lines(
      plan({
        rows: [A, B, C],
        slices: [
          slice({
            id: 's-a-none',
            workItemId: 'a',
            personId: null,
            earliestStart: 4,
            earliestFinish: 5,
          }),
          slice({
            id: 's-b-bo',
            workItemId: 'b',
            personId: 'person-bo',
            earliestStart: 3,
            earliestFinish: 4,
          }),
          slice({
            id: 's-c-ada',
            workItemId: 'c',
            personId: 'person-ada',
            earliestStart: 4,
            earliestFinish: 5,
          }),
          slice({ id: 's-a-ada', workItemId: 'a', personId: 'person-ada' }),
        ],
      }),
      'assignee',
    );
    expect(text.filter((line) => line.startsWith('section'))).toEqual([
      'section Ada',
      'section Bo',
      'section unassigned',
    ]);
    expect(text.filter((line) => line.includes(', 2026-'))).toEqual([
      '010 Strip - Dev (Ada) :s1, 2026-09-01, 2026-09-03',
      '030 Test - Dev (Ada) :s2, 2026-09-07, 2026-09-07',
      '020 Rewire - Dev (Bo) :s3, 2026-09-04, 2026-09-04',
      '010 Strip - Dev :s4, 2026-09-07, 2026-09-07',
    ]);
  });

  it("escapes a step's or a person's own name the same way a row's is escaped", () => {
    const text = lines(
      plan({
        steps: [{ id: 'step-x', name: 'QA: final' }],
        people: [{ id: 'person-x', name: 'Grace: on call' }],
        slices: [slice({ id: 's', workItemId: 'a', stepId: 'step-x', personId: 'person-x' })],
      }),
      'step',
    );
    expect(text).toContain('section QA∶ final');
    expect(
      lines(
        plan({
          steps: [{ id: 'step-x', name: 'QA' }],
          people: [{ id: 'person-x', name: 'Grace: on call' }],
          slices: [slice({ id: 's', workItemId: 'a', stepId: 'step-x', personId: 'person-x' })],
        }),
        'assignee',
      ),
    ).toContain('section Grace∶ on call');
  });

  it('passes the choice through to the bundled document (M2), same fence either way', () => {
    const result = planToMermaidDocument(plan(), 'step');
    if (!result.drawn) throw new Error('expected a document');
    expect(result.text).toContain('section Dev');
    expect(result.text).not.toContain('section 010 Strip');
  });

  it('admits the three groupings it offers and nothing else', () => {
    // The boundary the toolbar's picker reads a browser's remembered answer
    // through — `wbs-table.tsx`'s `rememberedMermaidSectionMode`, whose two
    // refusal tests are the watched ones. Here the list and the type are
    // asserted not to have drifted apart: `SECTION_MODES` is what both the
    // `<option>`s and this guard are built from.
    for (const mode of SECTION_MODES) expect(isSectionMode(mode)).toBe(true);
    expect(SECTION_MODES).toEqual(['outline', 'step', 'assignee']);
    expect(DEFAULT_SECTION_MODE).toBe('outline');
    for (const claimed of ['assignees', 'phase', 'Outline', '', null, undefined, 0, ['step']]) {
      expect(isSectionMode(claimed)).toBe(false);
    }
  });
});

describe('the escaping', () => {
  it('keeps a colon in a name out of the position Mermaid splits on', () => {
    // A colon does not break the diagram — it silently moves the split, and the
    // reader gets a task whose id is a word out of somebody's name.
    const text = lines(plan({ rows: [row({ id: 'a', number: '010', name: 'Step 1: strip' })] }));
    expect(text).toContain('010 Step 1∶ strip - Dev :s1, 2026-09-01, 2026-09-03');
  });

  it('collapses a line break in a name, which would end the line halfway', () => {
    const text = lines(
      plan({ rows: [row({ id: 'a', number: '010', name: 'Strip\r\nthe shed' })] }),
    );
    expect(text).toContain('010 Strip the shed - Dev :s1, 2026-09-01, 2026-09-03');
  });

  it('defuses a comment opener in a name, which would eat the rest of the line', () => {
    const text = lines(plan({ rows: [row({ id: 'a', number: '010', name: '50%% done' })] }));
    expect(text).toContain('010 50% done - Dev :s1, 2026-09-01, 2026-09-03');
  });

  it('leaves alone what only the metadata position reads', () => {
    // A comma, a `#` and a `;` terminate metadata, and nothing anybody typed
    // reaches the metadata position — the ids are generated. Escaping them
    // would export names nobody wrote.
    const text = lines(plan({ rows: [row({ id: 'a', number: '010', name: 'Strip, #2; fast' })] }));
    expect(text).toContain('010 Strip, #2; fast - Dev :s1, 2026-09-01, 2026-09-03');
  });

  it('keeps a comment from being ended early by a project name', () => {
    expect(drawn(plan({ projectName: 'Shed\nworks' }))).toContain(
      '%% Shed works — exported from the WBS tool',
    );
  });
});

describe('what M1 deliberately does not print', () => {
  it('prints no team name anywhere, on a plan whose rows carry one', () => {
    // The decision that keeps this change independent of R2, which is rewriting
    // `ServiceTeamLabel` into `teams[]` and `services[]` this week. The team is
    // in the exported table either way.
    const text = drawn(
      plan({
        rows: [row({ id: 'a', number: '010', name: 'Strip', teamIds: ['team-billing'] })],
      }),
    );
    expect(text).not.toContain('Billing');
  });

  it('asks Mermaid to compute nothing: no after, and every task dated twice', () => {
    // `after` is a layout instruction. Mermaid knows nothing about capacity
    // floors, person floors, step order or not-before dates, so a diagram laid
    // out by it would silently disagree with be-01 on exactly the plans where
    // the disagreement matters.
    const text = drawn(
      plan({
        rows: [
          row({ id: 'a', number: '010', name: 'Strip' }),
          row({ id: 'b', number: '020', name: 'Rewire', dependsOn: ['a'] }),
        ],
        slices: [
          slice({ id: 's1', workItemId: 'a' }),
          slice({ id: 's2', workItemId: 'b', earliestStart: 3, earliestFinish: 6 }),
        ],
      }),
    );
    expect(text).not.toContain('after');
    expect(text).toContain(':s2, 2026-09-04, 2026-09-08');
  });

  it('writes the same bytes twice for the same plan', () => {
    expect(drawn(plan())).toEqual(drawn(plan()));
  });
});

describe('planToMermaidDocument — the bundled document (M2)', () => {
  /** The document, or the failure of a test that expected one. */
  function bundled(document: PlanExport): string {
    const result = planToMermaidDocument(document);
    if (!result.drawn) throw new Error(`expected a document, got a refusal: ${result.refusal}`);
    return result.text;
  }

  it('bundles the header, the fence and the table, in that order', () => {
    const text = bundled(plan());
    const headerAt = text.indexOf('**Project:**');
    const fenceOpenAt = text.indexOf('```mermaid');
    const ganttAt = text.indexOf('\ngantt\n');
    const fenceCloseAt = text.indexOf('```\n', fenceOpenAt + 1);
    const tableAt = text.indexOf('| Number |');
    expect(headerAt).toBeGreaterThanOrEqual(0);
    expect(fenceOpenAt).toBeGreaterThan(headerAt);
    expect(ganttAt).toBeGreaterThan(fenceOpenAt);
    expect(fenceCloseAt).toBeGreaterThan(ganttAt);
    expect(tableAt).toBeGreaterThan(fenceCloseAt);
  });

  it('says in its header that the document is the whole plan, not what is on screen', () => {
    // Q6 of the R7 brief: the chart draws `shownRows`, this document draws
    // every row, and the divergence has to be a sentence or the first bug
    // report is "the export added rows".
    expect(bundled(plan())).toContain('**Scope:** the whole plan, not what is on screen');
  });

  it('says which rows it holds, and says it once, when it is not the whole plan', () => {
    // The doctrine Q3 settled, in the one place it could be broken quietly: a
    // document carrying a scope already says what it holds, and the whole-plan
    // sentence beside it would be a second `Scope` line claiming the opposite.
    const text = bundled(plan({ scope: { totalRows: 6, criteria: ['team Billing, Ltd'] } }));

    expect(text).not.toContain('**Scope:** the whole plan, not what is on screen');
    expect(text.match(/\*\*Scope:\*\*/g)).toHaveLength(1);
    expect(text).toContain('what one reader had on screen, not the whole plan — 1 of 6 rows');
    // And inside the fence, which is the part that gets pasted somewhere the
    // header is not.
    expect(text).toContain(
      '%% Only what one reader had on screen is here — 1 of 6 rows. The rest of the plan is not drawn.',
    );
  });

  it('embeds the same table planToMarkdown writes for the same plan', () => {
    const document = plan();
    expect(bundled(document)).toContain(markdownTableLines(document).join('\n'));
  });

  it('refuses exactly where the diagram refuses, and says the same sentence', () => {
    expect(planToMermaidDocument(plan({ startDate: null }))).toEqual({
      drawn: false,
      refusal: NOT_ON_A_CALENDAR,
    });
    expect(planToMermaidDocument(plan({ scheduleError: 'cycle' }))).toEqual({
      drawn: false,
      refusal: NO_SCHEDULE_TO_DRAW,
    });
    expect(planToMermaidDocument(plan({ slices: [] }))).toEqual({
      drawn: false,
      refusal: NOTHING_PLACED,
    });
  });

  it('puts no document in a refusal, so a download cannot save one', () => {
    const result = planToMermaidDocument(plan({ startDate: null }));
    expect(result.drawn).toBe(false);
    expect('text' in result).toBe(false);
  });

  it('widens the fence past a backtick run in a task name, so the name cannot close it early', () => {
    // Proof: at a fixed ``` fence, a name carrying ```evil``` would close the
    // code block right after that task's line, and the rest of the diagram
    // plus the whole table would fall outside the fence as ordinary prose
    // instead of inside it.
    const text = bundled(
      plan({ rows: [row({ id: 'a', number: '010', name: 'Strip ```evil``` cables' })] }),
    );
    const fenceLines = text.split('\n').filter((line) => /^`{3,}(mermaid)?$/.test(line));
    expect(fenceLines).toEqual(['````mermaid', '````']);
    const [open, close] = fenceLines;
    const closeAt = text.indexOf(close, text.indexOf(open) + open.length);
    expect(text.indexOf('| Number |')).toBeGreaterThan(closeAt);
  });
});

/**
 * A real Mermaid parse (M5 of the R7 brief) — pinning §3.2's `manualEndTime`
 * trap, §3.3's inclusivity and §3.4's escaping against Mermaid's own grammar
 * rather than against `gantt.jison`/`ganttDb.js` read by eye.
 *
 * Every test above this point asserts a **string** — that the writer emitted
 * the bytes it meant to. None of them prove Mermaid *reads* those bytes the
 * way the writer's docstrings argue it does. The `excludes weekends` /
 * `manualEndTime` interaction in particular rests on one hardcoded literal
 * inside Mermaid's own source (`ganttDb.js:490`, quoted in the brief) — an
 * upstream tidy-up there would move our dates with no string assertion able
 * to notice. `mermaid.mermaidAPI.getDiagramFromText` is the one place this
 * suite can ask the real parser what it believes: it runs the actual
 * `gantt.jison` grammar and the actual `ganttDb.js` date arithmetic, and hands
 * back the same task objects `ganttRenderer.js` draws from — a `startTime`/
 * `endTime` pair already adjusted for `excludes`/`includes`/inclusivity, and
 * the `manualEndTime` flag that arithmetic keyed off.
 *
 * `mermaidAPI` is `@internal`/`@deprecated` on Mermaid's own public surface
 * (the documented API is `parse`/`render`, and `render` demands a live SVG
 * container this suite has no reason to build) — the one way to reach parsed
 * task data instead of pixels. `mermaid` is a **devDependency only**: nothing
 * under `src/` imports it, and this file is the sole caller.
 */
describe('a real Mermaid parse (M5)', () => {
  let mermaid: Mermaid;

  /**
   * What this suite reads off `diagram.db` — a narrow slice of Mermaid's own
   * `ganttDb.js` surface, typed by hand because `Diagram.db` is `unknown` on
   * Mermaid's public types (the gantt-specific shape lives in an internal
   * module this file deliberately does not import from).
   */
  interface RealGanttTask {
    readonly id: string;
    readonly task: string;
    readonly section: string;
    readonly manualEndTime: boolean;
    readonly milestone?: boolean;
    readonly crit?: boolean;
    readonly startTime: Date;
    readonly endTime: Date;
  }
  interface RealGanttDb {
    getTasks(): RealGanttTask[];
    getSections(): string[];
    endDatesAreInclusive(): boolean;
  }

  beforeAll(async () => {
    // Dynamic and once for the whole file: `mermaid` pulls in d3, cytoscape
    // and friends, so paying for the module graph 60 times (once per `it`)
    // would be the whole cost of this change and none of its evidence.
    mermaid = (await import('mermaid')).default;
    mermaid.initialize({ startOnLoad: false });
  });

  /** The real diagram Mermaid itself builds from `text` — parse, not string. */
  async function realGantt(text: string): Promise<{ type: string; db: RealGanttDb }> {
    // `mermaidAPI` is deprecated in favour of the documented `parse`/`render`
    // pair — but `render` demands a live SVG container to draw into, and
    // `parse` only validates syntax, returning nothing about dates or ids.
    // `getDiagramFromText` is the one path Mermaid ships to a parsed
    // diagram's task data without asking this suite to build pixels.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const diagram = await mermaid.mermaidAPI.getDiagramFromText(text);
    return { type: diagram.type, db: diagram.db as unknown as RealGanttDb };
  }

  describe('the excludes-weekends trap, watched rather than argued', () => {
    it('leaves a bar crossing a weekend exactly where it was told, manualEndTime true', async () => {
      // The same span the string-assertion test above already covers —
      // workdays 3 to 6, Friday the 4th through Tuesday the 8th — now read
      // back through the real parser instead of asserted as a substring.
      const text = drawn(
        plan({
          slices: [slice({ id: 's', workItemId: 'a', earliestStart: 3, earliestFinish: 6 })],
        }),
      );
      const { type, db } = await realGantt(text);
      expect(type).toBe('gantt');
      const [task] = db.getTasks();
      // `checkTaskDates` returns early on a `manualEndTime` task and never
      // reaches the branch that would push these dates past the weekend —
      // if it did not, `endTime` would land on a later workday than this.
      expect(task.manualEndTime).toBe(true);
      expect(task.startTime.toISOString()).toBe('2026-09-04T00:00:00.000Z');
      // Mermaid's own end is exclusive internally; `inclusiveEndDates` is what
      // makes the *declared* 2026-09-08 the last day drawn, so the internal
      // value one day past it is the proof the declaration was believed, not
      // a bug in this assertion.
      expect(task.endTime.toISOString()).toBe('2026-09-09T00:00:00.000Z');
    });

    it('declares inclusiveEndDates, and Mermaid reports believing it', async () => {
      const { db } = await realGantt(drawn(plan()));
      expect(db.endDatesAreInclusive()).toBe(true);
    });

    it('still parses a point (unestimated/zero) as a real milestone with equal dates', async () => {
      const text = drawn(
        plan({
          slices: [
            slice({
              id: 's',
              workItemId: 'a',
              earliestStart: 2,
              earliestFinish: 2,
              duration: 0,
              effort: 0,
            }),
          ],
        }),
      );
      const { db } = await realGantt(text);
      const [task] = db.getTasks();
      expect(task.milestone).toBe(true);
      expect(task.manualEndTime).toBe(true);
      expect(task.startTime.toISOString()).toBe('2026-09-03T00:00:00.000Z');
    });
  });

  describe('the colon escape, watched against the real lexer', () => {
    it('keeps a colon in a name from moving the split, once escaped', async () => {
      const text = drawn(plan({ rows: [row({ id: 'a', number: '010', name: 'Step 1: strip' })] }));
      const { type, db } = await realGantt(text);
      expect(type).toBe('gantt');
      const [task] = db.getTasks();
      // The id the writer generated, not a word torn out of the name — which
      // is exactly what an unescaped colon would produce, proven next.
      expect(task.id).toBe('s1');
      expect(task.task).toContain('Step 1∶ strip');
    });

    it('— and unescaped, the real lexer does silently move the split', async () => {
      // Not `planToMermaid`'s output: hand-built text standing in for what
      // `mermaidPhrase` refuses to emit, so this test watches the failure
      // mode the escaping exists to prevent rather than taking the brief's
      // reading of `gantt.jison` on faith.
      const text = [
        'gantt',
        'dateFormat YYYY-MM-DD',
        'inclusiveEndDates',
        'excludes weekends',
        'section S',
        'Step 1: strip :s1, 2026-09-01, 2026-09-03',
      ].join('\n');
      const { db } = await realGantt(text);
      const [task] = db.getTasks();
      // The colon split the line at "Step 1", not where the writer's own
      // `s1` id was typed — id and dates alike are dragged out of the
      // metadata position and mangled, silently, with no parse error at all.
      expect(task.task).toBe('Step 1');
      expect(task.id).not.toBe('s1');
    });
  });

  describe('all three section modes #71 added, each a real, error-free gantt', () => {
    const A = row({ id: 'a', number: '010', name: 'Strip' });
    const B = row({ id: 'b', number: '020', name: 'Rewire' });
    const twoByTwo = plan({
      rows: [A, B],
      slices: [
        slice({
          id: 's-a-dev',
          workItemId: 'a',
          stepId: DEV.id,
          personId: 'person-ada',
        }),
        slice({
          id: 's-a-qa',
          workItemId: 'a',
          stepId: QA.id,
          personId: 'person-bo',
          earliestStart: 3,
          earliestFinish: 4,
        }),
        slice({
          id: 's-b-dev',
          workItemId: 'b',
          stepId: DEV.id,
          personId: 'person-ada',
          earliestStart: 4,
          earliestFinish: 5,
        }),
        slice({
          id: 's-b-qa',
          workItemId: 'b',
          stepId: QA.id,
          personId: 'person-bo',
          earliestStart: 5,
          earliestFinish: 6,
        }),
      ],
    });

    const cases: { mode: SectionMode; sections: string[] }[] = [
      { mode: 'outline', sections: ['010 Strip', '020 Rewire'] },
      { mode: 'step', sections: ['Dev', 'QA'] },
      { mode: 'assignee', sections: ['Ada', 'Bo'] },
    ];

    it.each(cases)(
      '$mode draws four tasks under $sections, and Mermaid parses it clean',
      async ({ mode, sections }) => {
        const text = drawn(twoByTwo, mode);
        const { type, db } = await realGantt(text);
        expect(type).toBe('gantt');
        expect(db.getSections()).toEqual(sections);
        expect(db.getTasks()).toHaveLength(4);
      },
    );
  });
});
