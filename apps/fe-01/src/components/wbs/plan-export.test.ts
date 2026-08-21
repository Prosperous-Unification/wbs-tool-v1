import { DEFAULT_PRIORITY_BANDS } from '@wbs/domain/priority-band';
import { describe, expect, it } from 'vitest';

import {
  type ExportRow,
  type ExportSlice,
  markdownHeaderLines,
  markdownTableLines,
  type PlanExport,
  planFileName,
  planToCsv,
  planToMarkdown,
} from './plan-export';

/**
 * An RFC 4180 reader with no leniency in it, written here rather than imported.
 *
 * The point of writing it in the test is that it knows nothing about the writer
 * it is checking: it doubles quotes back, treats CRLF and only CRLF as the
 * record separator, and keeps everything else — a bare LF included — as data.
 * A writer that ends its lines with `\n`, or that fails to double a quote,
 * produces something this reads as a different table, which is what makes the
 * round-trip assertions below able to fail.
 */
function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let at = 0;
  while (at < text.length) {
    const char = text.slice(at, at + 1);
    if (quoted) {
      if (char === '"') {
        if (text.slice(at + 1, at + 2) === '"') {
          field += '"';
          at += 2;
          continue;
        }
        quoted = false;
        at += 1;
        continue;
      }
      field += char;
      at += 1;
      continue;
    }
    if (char === '"') {
      quoted = true;
      at += 1;
      continue;
    }
    if (char === ',') {
      record.push(field);
      field = '';
      at += 1;
      continue;
    }
    if (char === '\r' && text.slice(at + 1, at + 2) === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      at += 2;
      continue;
    }
    field += char;
    at += 1;
  }
  record.push(field);
  records.push(record);
  return records;
}

const DEV = { id: 'role-dev', name: 'Dev' };
const QA = { id: 'role-qa', name: 'QA' };

const row = (over: Partial<ExportRow> & Pick<ExportRow, 'id' | 'number'>): ExportRow => ({
  // At the root and one at a time, which is every row of a plan nobody has
  // arranged or widened. Both spelled out rather than left off, for the reason
  // the `priority` comment below records: a `Partial` spread satisfies a
  // required field the base object omits, so an omission compiles and every row
  // in this file would carry `undefined` — `parentId: undefined` walks no
  // ancestry, and `maxParallel: undefined` is neither 1 nor a number.
  parentId: null,
  maxParallel: 1,
  name: '',
  notes: '',
  rolledUp: false,
  teamIds: [],
  // Both spelled out for the same reason as everything above, and neither was
  // until 2026-08-21: `Partial` satisfies a required field the base omits, so
  // every row in this file carried `undefined` in both label dimensions. The
  // walk tolerates it (`effectiveLabelsOf` guards on `!== undefined`), which is
  // exactly why nothing failed and why the Tags column had no cell assertion at
  // all — an empty column and an absent field export identically.
  tagIds: [],
  serviceIds: [],
  estimates: {},
  finalDays: {},
  finalTotal: 0,
  dependsOn: [],
  startNoEarlierThan: null,
  // No floor, so no words about one — the pair be-01 refuses is the only one
  // this fixture cannot build by accident.
  startNoEarlierThanReason: null,
  dates: null,
  schedule: { earliestStart: 0, earliestFinish: 0, float: 0, critical: false },
  assignees: {},
  doesEveryPhase: null,
  // Unranked, and spelled out rather than left off. `ExportRow.priority` is
  // `number | null` and not optional, but a spread of a `Partial` satisfies
  // that check, so the omission compiled — and every row every test in this
  // file built carried `undefined`, which `String()` turns into the literal
  // text `undefined` in the Priority column. Found 2026-08-11 by the first
  // assertion that read the cell rather than the header.
  priority: null,
  ...over,
});

const plan = (over: Partial<PlanExport> = {}): PlanExport => ({
  projectName: 'Rewire the shed',
  generatedAt: '2026-08-07T09:15:00.000Z',
  method: 'pert',
  startDate: null,
  scheduleError: null,
  roles: [DEV, QA],
  teams: [{ id: 'team-billing', name: 'Billing, Ltd' }],
  tags: [
    { id: 'tag-regulatory', name: 'regulatory' },
    { id: 'tag-platform', name: 'platform' },
  ],
  // A comma in the first name on purpose, as `Billing, Ltd` is: the label
  // columns are the ones a service vocabulary lets a planner type prose into,
  // and a `; `-joined pair of them is the cell most likely to break a naive
  // writer's quoting.
  services: [
    { id: 'service-payments', name: 'Payments, retail' },
    { id: 'service-checkout', name: 'Checkout' },
  ],
  priorityBands: DEFAULT_PRIORITY_BANDS,
  people: [
    { id: 'person-ada', name: 'ada' },
    { id: 'person-bo', name: 'Bo "Boss"' },
  ],
  rows: [],
  // No placement at all, which is what an unscheduled plan and a plan read
  // before its first chart both hold. The Ran at column renders it as nothing
  // rather than as a 1 — see `ranAtCell`.
  slices: [],
  ...over,
});

/** The cells of the first data row of a CSV, past the header block. */
function csvDataRow(text: string, at = 0): string[] {
  const records = parseCsv(text);
  const blank = records.findIndex((record) => record.length === 1 && record[0] === '');
  return records[blank + 2 + at] ?? [];
}

/** The column headers of a CSV, which are the record after the blank one. */
function csvColumns(text: string): string[] {
  return csvDataRow(text, -1);
}

/**
 * Where one named column sits, read off the CSV's own header row.
 *
 * The Priority assertion has done this since 2026-08-11 and its comment gives
 * the reason: a column inserted to the left of the one under test moves a typed
 * index onto its neighbour, and the assertion then passes or fails about a
 * column nobody meant. `capacity-ui` inserted two of them after Team and broke
 * nine assertions that had typed theirs, which is the same lesson a second
 * time; every positional index in this file is now this call.
 *
 * Throws rather than answering `-1`, which would silently read the last cell of
 * every row.
 */
function columnAt(text: string, header: string): number {
  const at = csvColumns(text).indexOf(header);
  if (at === -1) throw new Error(`no ${header} column in ${csvColumns(text).join(', ')}`);
  return at;
}

/** The cells of one Markdown table row, by the number in its first column. */
function markdownRow(text: string, number: string): string[] {
  const line = text.split('\n').find((each) => each.startsWith(`| ${number} |`));
  if (line === undefined) throw new Error(`no row ${number} in\n${text}`);
  return line
    .slice(1, -1)
    .split(' | ')
    .map((cell) => cell.trim());
}

describe('the header block', () => {
  it('leads the Markdown with the project, the method by name and the timestamp', () => {
    const text = planToMarkdown(plan());
    const [first] = text.split('\n');
    expect(first).toBe('**Project:** Rewire the shed');
    expect(text).toContain('**Final figures:** PERT');
    expect(text).toContain('**Generated:** 2026-08-07T09:15:00.000Z');
    // Above the table, not below it: the block ends at the first table row.
    expect(text.indexOf('**Generated:**')).toBeLessThan(text.indexOf('| Number |'));
  });

  it('names every other method as the project named it', () => {
    expect(planToMarkdown(plan({ method: 'realistic' }))).toContain('**Final figures:** realistic');
    expect(planToMarkdown(plan({ method: 'pessimistic' }))).toContain(
      '**Final figures:** pessimistic',
    );
  });

  it('says the figures are unrounded and that an empty cell is not a zero', () => {
    const text = planToMarkdown(plan());
    expect(text).toContain('unrounded');
    expect(text).toContain('never zero');
  });

  it('leads the CSV with key,value rows, then a blank row, then the columns', () => {
    const records = parseCsv(planToCsv(plan()));
    expect(records[0]).toEqual(['Project', 'Rewire the shed']);
    expect(records[1]).toEqual(['Final figures', 'PERT']);
    const blank = records.findIndex((record) => record.length === 1 && record[0] === '');
    expect(blank).toBeGreaterThan(1);
    expect(records[blank + 1]?.[0]).toBe('Number');
  });

  it('says a plan is not on a calendar, and labels its schedule in days', () => {
    const text = planToMarkdown(
      plan({
        startDate: null,
        rows: [
          row({
            id: 'a',
            number: '010',
            schedule: { earliestStart: 2, earliestFinish: 5, float: 1, critical: false },
          }),
        ],
      }),
    );
    expect(text).toContain('**Start date:** not on a calendar');
    expect(markdownRow(text, '010')).toContain('day 2');
    expect(markdownRow(text, '010')).toContain('day 5');
  });

  it('says the dates skip weekends when the plan is on a calendar', () => {
    const text = planToMarkdown(
      plan({
        startDate: '2026-09-01',
        rows: [
          row({
            id: 'a',
            number: '010',
            dates: { startsOn: '2026-09-01', endsOn: '2026-09-03' },
            schedule: { earliestStart: 0, earliestFinish: 2, float: 0, critical: true },
          }),
        ],
      }),
    );
    expect(text).toContain('**Start date:** 2026-09-01');
    expect(text).toContain('dates skip weekends');
    const cells = markdownRow(text, '010');
    expect(cells).toContain('2026-09-01');
    expect(cells).toContain('2026-09-03');
    expect(cells).not.toContain('day 0');
  });

  it('says so when a cycle left the plan with no schedule at all', () => {
    const text = planToMarkdown(
      plan({
        scheduleError: 'cycle',
        rows: [row({ id: 'a', number: '010' })],
      }),
    );
    expect(text).toContain('run in a circle');
    // Not `day 0` for every row, which reads as "everything happens at once".
    expect(markdownRow(text, '010')).not.toContain('day 0');
    expect(markdownRow(text, '010')).toContain('—');
  });
});

describe('the columns', () => {
  it('labels each role final with the method that produced it', () => {
    expect(csvColumns(planToCsv(plan()))).toEqual([
      'Number',
      'Name',
      'Team',
      'Tags',
      'Services',
      'People at once',
      'Ran at',
      'Dev optimistic',
      'Dev realistic',
      'Dev pessimistic',
      'Dev final (PERT)',
      'Dev by',
      'QA optimistic',
      'QA realistic',
      'QA pessimistic',
      'QA final (PERT)',
      'QA by',
      'Total days (PERT)',
      'Depends on',
      'Priority',
      'Priority band',
      'Not before',
      'Not before because',
      'Starts',
      'Ends',
      'Slack',
      'Notes',
    ]);
    expect(csvColumns(planToCsv(plan({ method: 'optimistic' })))).toContain(
      'Dev final (optimistic)',
    );
  });

  it('answers three different questions in the three label columns', () => {
    // The assertion the three columns existed without: one row stating all
    // three dimensions, each cell read by name and checked for the other two's
    // answers. A shared rendering (which is what `labelCell` is) makes "they
    // print the same sentence" cheap and "they print the same *contents*" the
    // fault worth watching.
    const text = planToCsv(
      plan({
        rows: [
          row({
            id: 'a',
            number: '010',
            name: 'Strip the walls',
            teamIds: ['team-billing'],
            tagIds: ['tag-regulatory'],
            serviceIds: ['service-checkout'],
          }),
        ],
      }),
    );
    const cells = csvDataRow(text);
    expect(cells[columnAt(text, 'Team')]).toBe('Billing, Ltd');
    expect(cells[columnAt(text, 'Tags')]).toBe('regulatory');
    expect(cells[columnAt(text, 'Services')]).toBe('Checkout');
  });

  it('names every service a row delivers, and quotes the join', () => {
    // Plural since the 2026-08-21 scope change: printing `serviceIds[0]` is the
    // fault this watches, and the comma inside the first name is what makes the
    // round trip prove the quoting rather than just the text.
    const text = planToCsv(
      plan({
        rows: [
          row({
            id: 'a',
            number: '010',
            serviceIds: ['service-payments', 'service-checkout'],
          }),
        ],
      }),
    );
    expect(csvDataRow(text)[columnAt(text, 'Services')]).toBe('Payments, retail; Checkout');
    // Read back by an RFC 4180 parser that knows nothing about the writer: a
    // cell holding a comma that was written bare would arrive here as two.
    expect(csvColumns(text).length).toBe(csvDataRow(text).length);
  });

  it('says which row a service was inherited from', () => {
    const text = planToCsv(
      plan({
        rows: [
          row({
            id: 'a',
            number: '010',
            name: 'Strip the walls',
            serviceIds: ['service-checkout'],
          }),
          row({ id: 'a1', number: '010.1', name: 'Sockets', parentId: 'a' }),
        ],
      }),
    );
    expect(csvDataRow(text, 1)[columnAt(text, 'Services')]).toBe(
      'Checkout (inherited from 010 Strip the walls)',
    );
  });

  it('leaves the Services cell empty where nothing above the row states one', () => {
    // Absence, and not a placeholder: the third dimension spells unstated the
    // way the other two do, and a plan nobody has put on a service exports a
    // blank column rather than a column of dashes.
    const text = planToCsv(plan({ rows: [row({ id: 'a', number: '010' })] }));
    expect(csvDataRow(text)[columnAt(text, 'Services')]).toBe('');
  });

  it('carries the Services cell into the Markdown table as well', () => {
    // Both writers or neither: `columnsOf` is shared, and this is the assertion
    // that keeps a column from being added to one format's list by hand.
    const text = planToMarkdown(
      plan({
        rows: [row({ id: 'a', number: '010', serviceIds: ['service-checkout'] })],
      }),
    );
    expect(markdownRow(text, '010')).toContain('Checkout');
  });

  it('names the band beside the number, from the plan’s own ladder', () => {
    // The name **beside** the number and not instead of it: the number is what the
    // plan sorts by, the name is what a reader of the export talks about, and
    // neither substitutes for the other — two rows at 10 and 18 are both
    // `Critical` and are not the same priority.
    //
    // A spreadsheet outlives the plan it came from, which is why the ladder
    // travels with the export rather than being inferred: a CSV saying `Critical`
    // for 10 is still readable the day somebody re-cuts the ladder.
    //
    // Proof: `plan.priorityBands` replaced by `DEFAULT_PRIORITY_BANDS` in the
    // cell, and this failed on `expected 'Critical' to be 'Blocker'` — an export
    // naming a band the plan it came from does not have. Watched 2026-08-14.
    const rows = [
      row({ id: 'a', number: '010', priority: 10 }),
      row({ id: 'b', number: '020', priority: 90 }),
      row({ id: 'c', number: '030' }),
    ];
    const csv = planToCsv(plan({ rows }));
    const at = csvColumns(csv).indexOf('Priority band');

    expect(csvDataRow(csv)[at]).toBe('Critical');
    expect(csvDataRow(csv, 1)[at]).toBe('Lowest');
    // Blank where the number is, for the reason the Priority column is: unranked
    // is a state of its own and a spreadsheet reader sorting on it wants an empty
    // cell.
    expect(csvDataRow(csv, 2)[at]).toBe('');

    const recut = planToCsv(
      plan({
        rows,
        priorityBands: [
          { startsAt: 1, label: 'Blocker', defaultValue: 5 },
          { startsAt: 16, label: 'Urgent', defaultValue: 20 },
          { startsAt: 31, label: 'Normal', defaultValue: 40 },
          { startsAt: 71, label: 'Someday', defaultValue: 75 },
          { startsAt: 200, label: 'Never', defaultValue: 900 },
        ],
      }),
    );
    expect(csvDataRow(recut)[at]).toBe('Blocker');
    expect(csvDataRow(recut, 1)[at]).toBe('Someday');
  });

  it('writes the words about a not-before beside the date, in a column of their own', () => {
    // A column rather than a suffix on the date, which is how every other piece
    // of row text is carried here: a spreadsheet reader sorts and filters `Not
    // before` as a date, and `2026-09-12 — waiting on client sign-off` is a date
    // column that has stopped being one.
    //
    // The index is read off the header rather than typed, so a column inserted
    // to the left moves this assertion with it instead of silently pointing it
    // at Starts.
    const rows = [
      row({
        id: 'a',
        number: '010',
        startNoEarlierThan: '2026-09-12',
        startNoEarlierThanReason: 'waiting on client sign-off',
      }),
      // A date nobody explained: blank, exactly as the Priority column is for
      // an unranked row, and not a dash or the word `null`.
      row({ id: 'b', number: '020', startNoEarlierThan: '2026-09-12' }),
      row({ id: 'c', number: '030' }),
    ];
    const csv = planToCsv(plan({ rows }));
    const at = columnAt(csv, 'Not before because');
    const date = columnAt(csv, 'Not before');

    expect(csvDataRow(csv)[at]).toBe('waiting on client sign-off');
    expect(csvDataRow(csv)[date]).toBe('2026-09-12');
    expect(csvDataRow(csv, 1)[at]).toBe('');
    expect(csvDataRow(csv, 2)[at]).toBe('');
  });

  it('escapes a reason like any other row text, in both formats', () => {
    // A reason is a sentence somebody typed, so it holds commas, quotes, pipes
    // and line breaks like a note does — and it goes through the same
    // `csvField` and `markdownCell` those are escaped by rather than a second
    // path written for it.
    //
    // The leading `=` is the formula guard: a spreadsheet opening this file
    // would otherwise evaluate the cell. `Notes` has been guarded since the
    // export was written and a second free-text column that was not would be a
    // hole in one place.
    const reason = '=SUM(A1), "urgent" | held\nuntil sign-off';
    const rows = [
      row({
        id: 'a',
        number: '010',
        startNoEarlierThan: '2026-09-12',
        startNoEarlierThanReason: reason,
      }),
    ];

    const csv = planToCsv(plan({ rows }));
    // Parsed back out of the CSV rather than matched against the raw text: what
    // matters is that a reader recovers the sentence, quotes and commas and all.
    expect(csvDataRow(csv)[columnAt(csv, 'Not before because')]).toBe(`'${reason}`);

    const markdown = planToMarkdown(plan({ rows }));
    const heading = markdown
      .split('\n')
      .find((each) => each.startsWith('| Number |'))
      ?.slice(1, -1)
      .split(' | ')
      .map((cell) => cell.trim());
    const column = heading?.indexOf('Not before because') ?? -1;
    expect(column).toBeGreaterThan(-1);
    // The pipe escaped so it cannot open a column nobody asked for, and the line
    // break flattened so it cannot end the row halfway through.
    expect(markdownRow(markdown, '010')[column]).toBe('=SUM(A1), "urgent" \\| held until sign-off');
  });

  it('writes a priority as the number somebody typed, and an unranked row blank', () => {
    // The header alone was pinned until 2026-08-11, and a column whose cell is
    // never read is a column that can quietly export the wrong thing. `2`, not
    // `2.0` and not the row's position; blank, not `0` and not `—` — unranked
    // is a state of its own, exactly as the cell in the table is blank.
    //
    // The index is read off the header rather than typed, so inserting a column
    // to the left of Priority moves this assertion with it instead of silently
    // pointing it at Not before.
    const rows = [row({ id: 'a', number: '010', priority: 2 }), row({ id: 'b', number: '020' })];
    const csv = planToCsv(plan({ rows }));
    const at = csvColumns(csv).indexOf('Priority');

    expect(csvDataRow(csv)[at]).toBe('2');
    expect(csvDataRow(csv, 1)[at]).toBe('');

    const markdown = planToMarkdown(plan({ rows }));
    const heading = markdown
      .split('\n')
      .find((each) => each.startsWith('| Number |'))
      ?.slice(1, -1)
      .split(' | ')
      .map((cell) => cell.trim());
    const column = heading?.indexOf('Priority') ?? -1;
    expect(column).toBeGreaterThan(-1);
    expect(markdownRow(markdown, '010')[column]).toBe('2');
    expect(markdownRow(markdown, '020')[column]).toBe('');
  });

  it('carries the number as the only outline there is, indenting nothing', () => {
    const text = planToMarkdown(
      plan({
        rows: [
          row({ id: 'a', number: '010', name: 'Wiring' }),
          row({ id: 'b', number: '010.1', name: 'Sockets' }),
        ],
      }),
    );
    expect(markdownRow(text, '010.1')[0]).toBe('010.1');
    expect(markdownRow(text, '010.1')[1]).toBe('Sockets');
  });

  it('resolves the team to its name, and says so when the id names nobody', () => {
    const rows = [
      row({ id: 'a', number: '010', teamIds: ['team-billing'] }),
      row({ id: 'b', number: '020', teamIds: ['team-gone'] }),
      row({ id: 'c', number: '030' }),
    ];
    const csv = planToCsv(plan({ rows }));
    const team = columnAt(csv, 'Team');
    expect(csvDataRow(csv)[team]).toBe('Billing, Ltd');
    expect(csvDataRow(csv, 1)[team]).toBe('(unknown)');
    expect(csvDataRow(csv, 2)[team]).toBe('');
  });

  it('resolves dependencies to numbers, comma-joined, dropping ones that have gone', () => {
    const rows = [
      row({ id: 'a', number: '010' }),
      row({ id: 'b', number: '020' }),
      row({ id: 'c', number: '030', dependsOn: ['a', 'gone', 'b'] }),
    ];
    const csv = planToCsv(plan({ rows }));
    expect(csvDataRow(csv, 2)[columnAt(csv, 'Depends on')]).toBe('010, 020');
  });

  it('says who is assumed to do a phase nobody was assigned to', () => {
    const rows = [
      row({
        id: 'a',
        number: '010',
        assignees: { 'role-dev': 'person-ada' },
        doesEveryPhase: 'person-ada',
      }),
    ];
    const csv = planToCsv(plan({ rows }));
    const cells = csvDataRow(csv);
    expect(cells[columnAt(csv, 'Dev by')]).toBe('ada');
    expect(cells[columnAt(csv, 'QA by')]).toBe(
      'ada (assumed — the only assignee does every phase)',
    );
  });

  it('names an assignee nobody knows rather than printing an id', () => {
    const rows = [row({ id: 'a', number: '010', assignees: { 'role-dev': 'person-gone' } })];
    const csv = planToCsv(plan({ rows }));
    const cells = csvDataRow(csv);
    expect(cells[columnAt(csv, 'Dev by')]).toBe('(unknown)');
    expect(cells[columnAt(csv, 'QA by')]).toBe('');
  });

  it('marks a critical row rather than printing its slack', () => {
    const rows = [
      row({
        id: 'a',
        number: '010',
        schedule: { earliestStart: 0, earliestFinish: 3, float: 0, critical: true },
      }),
      row({
        id: 'b',
        number: '020',
        schedule: { earliestStart: 0, earliestFinish: 3, float: 2.5, critical: false },
      }),
    ];
    const csv = planToCsv(plan({ rows }));
    expect(csvDataRow(csv)[columnAt(csv, 'Slack')]).toBe('critical');
    expect(csvDataRow(csv, 1)[columnAt(csv, 'Slack')]).toBe('2.5');
  });
});

describe('the capacity columns', () => {
  /**
   * A placed slice as the export needs one: whose row, how wide, how much work.
   *
   * The rest is be-01's `SliceView` filled with a neutral placement — since
   * `mermaid-gantt`, {@link ExportSlice} **is** that type rather than the
   * four-field narrowing of it that used to stand in `plan-export.ts`. These
   * columns read three of the fields and no more; the diagram writer next door
   * reads the others.
   */
  const slice = (workItemId: string, width: number, effort: number): ExportSlice => ({
    id: `${workItemId}-${String(width)}-${String(effort)}`,
    workItemId,
    roleId: DEV.id,
    personId: null,
    estimated: true,
    earliestStart: 0,
    earliestFinish: effort / width,
    latestStart: 0,
    latestFinish: effort / width,
    float: 0,
    critical: false,
    boundBy: 'projectStart',
    resourcePredecessorId: null,
    capacityPredecessorIds: [],
    width,
    effort,
    duration: effort / width,
  });

  it('prints every team of a set, joined', () => {
    // One member today, so this changes no cell in any plan that exists — but
    // the separator is the one R2-3's `Teams` column keeps and therefore the
    // one R3's import matches names by, so it is decided here rather than
    // discovered there.
    //
    // Proof: the cell narrowed to `nameOf(plan.teams, effective.teamIds[0])`,
    // and this failed on `expected 'Billing, Ltd' to be 'Billing, Ltd;
    // (unknown)'` — 1 failed / 38 passed; watched 2026-08-14.
    const rows = [row({ id: 'a', number: '010', teamIds: ['team-billing', 'team-gone'] })];
    const csv = planToCsv(plan({ rows }));

    expect(csvDataRow(csv)[columnAt(csv, 'Team')]).toBe('Billing, Ltd; (unknown)');
  });

  it('names the team a row inherits, and the row the label was written on', () => {
    const rows = [
      row({ id: 'a', number: '010', name: 'Backend', teamIds: ['team-billing'] }),
      row({ id: 'b', number: '010.1', name: 'Ship it', parentId: 'a' }),
    ];
    const csv = planToCsv(plan({ rows }));
    const team = columnAt(csv, 'Team');
    // The labelled row says the name alone: `(inherited from 010 Backend)` on
    // the row that carries the label would be the document telling a reader it
    // inherited from itself.
    expect(csvDataRow(csv)[team]).toBe('Billing, Ltd');
    expect(csvDataRow(csv, 1)[team]).toBe('Billing, Ltd (inherited from 010 Backend)');
  });

  it('leaves the Team cell empty where no row above carries a label at all', () => {
    const rows = [
      row({ id: 'a', number: '010', name: 'Backend' }),
      row({ id: 'b', number: '010.1', parentId: 'a' }),
    ];
    const csv = planToCsv(plan({ rows }));
    expect(csvDataRow(csv, 1)[columnAt(csv, 'Team')]).toBe('');
  });

  it('resolves the inherited label against every row of the plan, not the labelled one alone', () => {
    // Two levels of unlabelled rows between the leaf and the label. The walk
    // has to go through them, which is what "every row" buys over "the labelled
    // rows".
    //
    // Proof: `teamsInForce` pointed at `plan.rows.filter((r) => r.serviceTeamId
    // !== null)` rather than at every row, so an unlabelled row is simply not
    // in the map the chain is walked through. This failed on `expected '' to be
    // 'Billing, Ltd (inherited from 010 Root)'`, and took `names the team a row
    // inherits` with it — every inheriting row in the document reported
    // teamless while its dates came out of the pool. Watched 2026-08-13.
    const rows = [
      row({ id: 'a', number: '010', name: 'Root', teamIds: ['team-billing'] }),
      row({ id: 'b', number: '010.1', name: 'Nearer', parentId: 'a' }),
      row({ id: 'c', number: '010.1.1', name: 'Leaf', parentId: 'b' }),
    ];
    const csv = planToCsv(plan({ rows }));
    expect(csvDataRow(csv, 2)[columnAt(csv, 'Team')]).toBe(
      'Billing, Ltd (inherited from 010 Root)',
    );
  });

  it('writes the parallelism somebody typed, and leaves a row of one blank', () => {
    const rows = [row({ id: 'a', number: '010', maxParallel: 3 }), row({ id: 'b', number: '020' })];
    const csv = planToCsv(plan({ rows }));
    const at = columnAt(csv, 'People at once');
    expect(csvDataRow(csv)[at]).toBe('3');
    // Blank, not `1`: a column of ones down a plan nobody has widened is
    // furniture, and a spreadsheet sorting on it wants the empty cell.
    expect(csvDataRow(csv, 1)[at]).toBe('');
  });

  it('says what the schedule actually ran a row at, beside what was asked for', () => {
    const rows = [row({ id: 'a', number: '010', maxParallel: 4 })];
    // Asked for 4, ran at 2 — the team is smaller than the ask. Six days of
    // effort across two people is the three-day bar the dates already show, and
    // this is the only column that says why.
    const csv = planToCsv(plan({ rows, slices: [slice('a', 2, 6)] }));
    expect(csvDataRow(csv)[columnAt(csv, 'People at once')]).toBe('4');
    expect(csvDataRow(csv)[columnAt(csv, 'Ran at')]).toBe('2');
  });

  it('carries every width a row ran at rather than one of them', () => {
    // One phase assigned to somebody and one not: the assigned phase runs one
    // at a time whatever the row asks for, and the other runs three-up. Either
    // number alone is a claim about the whole row that is false of half of it.
    const rows = [row({ id: 'a', number: '010', maxParallel: 3 })];
    const csv = planToCsv(plan({ rows, slices: [slice('a', 3, 6), slice('a', 1, 2)] }));
    expect(csvDataRow(csv)[columnAt(csv, 'Ran at')]).toBe('1, 3');
  });

  it('leaves Ran at empty on a plan that was never placed', () => {
    // The same absence the dates report as an em dash. A `1` here would be this
    // document inventing a placement out of a plan that has none — and it is
    // the state every export taken before the first chart read is in.
    const rows = [row({ id: 'a', number: '010', maxParallel: 3 })];
    const csv = planToCsv(plan({ rows, slices: [] }));
    expect(csvDataRow(csv)[columnAt(csv, 'Ran at')]).toBe('');
    expect(csvDataRow(csv)[columnAt(csv, 'People at once')]).toBe('3');
  });

  it('leaves Ran at empty down an ordinary one-at-a-time plan', () => {
    const rows = [row({ id: 'a', number: '010' })];
    const csv = planToCsv(plan({ rows, slices: [slice('a', 1, 3)] }));
    expect(csvDataRow(csv)[columnAt(csv, 'Ran at')]).toBe('');
  });

  it('still reports a width of one where somebody asked for more', () => {
    // The row that most needs the column: 3 asked for, 1 given, and without
    // this the reader's only evidence is a bar that is three times too long.
    const rows = [row({ id: 'a', number: '010', maxParallel: 3 })];
    const csv = planToCsv(plan({ rows, slices: [slice('a', 1, 6)] }));
    expect(csvDataRow(csv)[columnAt(csv, 'Ran at')]).toBe('1');
  });

  it('reads only its own row’s slices', () => {
    const rows = [
      row({ id: 'a', number: '010', maxParallel: 2 }),
      row({ id: 'b', number: '020', maxParallel: 5 }),
    ];
    const csv = planToCsv(plan({ rows, slices: [slice('a', 2, 4), slice('b', 5, 10)] }));
    expect(csvDataRow(csv)[columnAt(csv, 'Ran at')]).toBe('2');
    expect(csvDataRow(csv, 1)[columnAt(csv, 'Ran at')]).toBe('5');
  });

  it('says in the header what the two columns mean', () => {
    // The header block is where a reader handed the table alone finds out that
    // the figures are effort. Without it a 6-day row spanning 2 days reads as
    // an export that is simply wrong.
    const text = planToMarkdown(plan());
    expect(text).toContain('**People:**');
    expect(text).toContain('effort divided by');
  });
});

describe('raw against displayed', () => {
  it('exports a final figure unrounded, not the one-decimal figure on screen', () => {
    const rows = [
      row({
        id: 'a',
        number: '010',
        estimates: { 'role-dev': { optimistic: 2, realistic: 3, pessimistic: 8 } },
        finalDays: { 'role-dev': 22 / 6 },
        finalTotal: 22 / 6,
      }),
    ];
    const csv = planToCsv(plan({ rows }));
    const cells = csvDataRow(csv);
    expect(cells[columnAt(csv, 'Dev final (PERT)')]).toBe('3.6666666666666665');
    expect(cells[columnAt(csv, 'Total days (PERT)')]).toBe('3.6666666666666665');
    expect(markdownRow(planToMarkdown(plan({ rows })), '010')).toContain('3.6666666666666665');
  });

  it('leaves an unestimated leaf empty, never zero', () => {
    const rows = [row({ id: 'a', number: '010', name: 'Nobody has looked' })];
    const cells = csvDataRow(planToCsv(plan({ rows })));
    // Every estimate cell of the two roles, their finals, and the total.
    expect(cells.slice(3, 14)).toEqual(['', '', '', '', '', '', '', '', '', '', '']);
    // A zero here would read as "this takes no time" rather than "nobody has
    // looked", which is the whole of the raw-versus-displayed rule.
    expect(markdownRow(planToMarkdown(plan({ rows })), '010').slice(3, 14)).toEqual([
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
    ]);
  });

  it('leaves the roles a row was never estimated for empty while another carries a figure', () => {
    const rows = [
      row({
        id: 'a',
        number: '010',
        estimates: { 'role-dev': { optimistic: 1, realistic: 1, pessimistic: 1 } },
        finalDays: { 'role-dev': 1 },
        finalTotal: 1,
      }),
    ];
    const csv = planToCsv(plan({ rows }));
    const cells = csvDataRow(csv);
    const dev = columnAt(csv, 'Dev optimistic');
    const qa = columnAt(csv, 'QA optimistic');
    expect(cells.slice(dev, dev + 4)).toEqual(['1', '1', '1', '1']);
    expect(cells.slice(qa, qa + 4)).toEqual(['', '', '', '']);
    expect(cells[columnAt(csv, 'Total days (PERT)')]).toBe('1');
  });

  it('marks a rolled-up parent’s figures as sums, in Markdown only', () => {
    const rows = [
      row({
        id: 'a',
        number: '010',
        rolledUp: true,
        estimates: { 'role-dev': { optimistic: 4, realistic: 6, pessimistic: 16 } },
        finalDays: { 'role-dev': 7 },
        finalTotal: 7,
      }),
    ];
    expect(markdownRow(planToMarkdown(plan({ rows })), '010')).toContain('7 (sum)');
    expect(planToCsv(plan({ rows }))).not.toContain('(sum)');
    const csv = planToCsv(plan({ rows }));
    expect(csvDataRow(csv)[columnAt(csv, 'Dev final (PERT)')]).toBe('7');
  });
});

describe('hostile text', () => {
  const nasty = [
    row({
      id: 'a',
      number: '010',
      name: 'a,b',
      notes: 'say "hi"',
      teamIds: ['team-billing'],
    }),
    row({
      id: 'b',
      number: '020',
      name: 'multi\r\nline\nname',
      notes: 'first line\nsecond, line\nthird "line"',
    }),
    row({ id: 'c', number: '030', name: '=SUM(A1)', notes: '@echo' }),
    row({ id: 'd', number: '040', name: '+1 (555) 0100', notes: '-3 days' }),
  ];

  it('round-trips every field through a reader that knows only RFC 4180', () => {
    const csv = planToCsv(plan({ rows: nasty }));
    const records = parseCsv(csv);
    const name = columnAt(csv, 'Name');
    const notes = columnAt(csv, 'Notes');
    expect(csvDataRow(csv, 0)[name]).toBe('a,b');
    expect(csvDataRow(csv, 0)[notes]).toBe('say "hi"');
    expect(csvDataRow(csv, 1)[name]).toBe('multi\r\nline\nname');
    expect(csvDataRow(csv, 1)[notes]).toBe('first line\nsecond, line\nthird "line"');
    // Every record has the same width — a field that broke out of its quotes
    // would show up here as a short or a long one. The width is the header
    // row's own count rather than a typed number, so a column added to the
    // export moves it instead of failing this on arithmetic.
    const widths = new Set(records.slice(-4).map((record) => record.length));
    expect([...widths]).toEqual([csvColumns(csv).length]);
  });

  it('separates records with CRLF, per RFC 4180', () => {
    const text = planToCsv(plan({ rows: [row({ id: 'a', number: '010' })] }));
    expect(text).toContain('\r\n');
    expect(text.split('\r\n').length).toBeGreaterThan(6);
    // No bare LF outside a quoted field: every line ending is the pair.
    expect(text.replaceAll('\r\n', '')).not.toContain('\n');
  });

  it('prefixes a field a spreadsheet would run as a formula', () => {
    const csv = planToCsv(plan({ rows: nasty }));
    const name = columnAt(csv, 'Name');
    const notes = columnAt(csv, 'Notes');
    expect(csvDataRow(csv, 2)[name]).toBe("'=SUM(A1)");
    expect(csvDataRow(csv, 2)[notes]).toBe("'@echo");
    expect(csvDataRow(csv, 3)[name]).toBe("'+1 (555) 0100");
    expect(csvDataRow(csv, 3)[notes]).toBe("'-3 days");
  });

  it('guards the header block too — a project name is a field like any other', () => {
    const csv = planToCsv(plan({ projectName: '=cmd|"/c calc"' }));
    expect(parseCsv(csv)[0]?.[1]).toBe('\'=cmd|"/c calc"');
  });

  it('keeps a Markdown table one row per work item, whatever is typed into it', () => {
    const text = planToMarkdown(plan({ rows: nasty }));
    // A pipe would open a column nobody asked for, and a newline would end the
    // row halfway through it.
    expect(markdownRow(text, '020')[1]).toBe('multi line name');
    const columns = markdownRow(text, '010').length;
    expect(markdownRow(text, '020')).toHaveLength(columns);
    expect(
      planToMarkdown(plan({ rows: [row({ id: 'a', number: '010', name: 'a|b' })] })).split('\n'),
    ).toContainEqual(expect.stringContaining('a\\|b'));
  });

  it('keeps the note’s Markdown source as it was written', () => {
    const text = planToMarkdown(
      plan({ rows: [row({ id: 'a', number: '010', notes: '**bold** and `code`' })] }),
    );
    expect(markdownRow(text, '010')).toContain('**bold** and `code`');
  });
});

describe('planFileName', () => {
  it('slugifies the project and dates the file by the timestamp it was given', () => {
    expect(planFileName(plan())).toBe('rewire-the-shed-2026-08-07.csv');
    expect(planFileName(plan({ projectName: 'Rewire  the Shed!! / v2' }))).toBe(
      'rewire-the-shed-v2-2026-08-07.csv',
    );
  });

  it('falls back to a name a file system can hold', () => {
    expect(planFileName(plan({ projectName: '???' }))).toBe('plan-2026-08-07.csv');
  });

  it('defaults to csv when no extension is asked for, so every existing caller is unchanged', () => {
    expect(planFileName(plan())).toBe(planFileName(plan(), 'csv'));
  });

  it('names the bundled Mermaid document md instead, on the same date and slug', () => {
    expect(planFileName(plan(), 'md')).toBe('rewire-the-shed-2026-08-07.md');
  });
});

describe('markdownHeaderLines and markdownTableLines', () => {
  it('join back into exactly what planToMarkdown writes, with no extra fields', () => {
    // A guard against the refactor that split the two apart drifting from the
    // function whose output it used to be: `plan-mermaid.ts` reuses both
    // pieces separately, and it can only trust them if they still compose to
    // the same document `planToMarkdown` has always written.
    const document = plan();
    expect(
      [...markdownHeaderLines(document), '', ...markdownTableLines(document), ''].join('\n'),
    ).toBe(planToMarkdown(document));
  });

  it('appends extra header fields after the ones planToMarkdown always carries', () => {
    const lines = markdownHeaderLines(plan(), [{ key: 'Scope', value: 'the whole plan' }]);
    expect(lines.at(-1)).toBe('**Scope:** the whole plan');
    expect(lines.slice(0, -1)).toEqual(markdownHeaderLines(plan()));
  });
});

describe('a document of what was on screen', () => {
  /** Three rows of a six-row plan, kept by a team facet and a typed name. */
  const narrowed = (over: Partial<PlanExport> = {}): PlanExport =>
    plan({
      rows: [
        row({ id: 'a', number: '010', name: 'Strip the walls' }),
        row({ id: 'a1', number: '010.1', name: 'Sockets', parentId: 'a', dependsOn: ['gone'] }),
      ],
      scope: { totalRows: 6, criteria: ['name contains “strip”', 'team Billing, Ltd'] },
      ...over,
    });

  it('says whose screen it is, how much of the plan is here, and what kept it', () => {
    const text = planToMarkdown(narrowed());

    expect(text).toContain(
      '**Scope:** what one reader had on screen, not the whole plan — 2 of 6 rows, ' +
        'kept by: name contains “strip”; team Billing, Ltd.',
    );
  });

  /**
   * The claim a reader cannot recover for themselves. Every date in a filtered
   * document is be-01's answer for the whole plan — the schedule is computed
   * over every row whatever the screen shows — and a reader who assumed the
   * dates had been re-planned around these rows would be reading a shorter,
   * entirely fictional project.
   */
  it('says the figures were not recomputed for the rows it kept', () => {
    expect(planToMarkdown(narrowed())).toContain(
      "The figures are the whole plan's schedule unchanged",
    );
  });

  it('counts the Depends on references pointing at rows it does not hold', () => {
    expect(planToMarkdown(narrowed())).toContain(
      '1 Depends on reference points at a work item this document does not hold',
    );
  });

  it('says nothing about holes where there are none', () => {
    const whole = narrowed({
      rows: [row({ id: 'a', number: '010', name: 'Strip the walls' })],
    });

    expect(planToMarkdown(whole)).toContain('1 of 6 rows');
    expect(planToMarkdown(whole)).not.toContain('Depends on reference');
  });

  it('names a collapsed branch as the narrowing when no filter was on', () => {
    const collapsed = narrowed({ scope: { totalRows: 6, criteria: [] } });

    expect(planToMarkdown(collapsed)).toContain(
      'no filter was on, so a collapsed branch is what left the rest out',
    );
  });

  it('carries the same sentence into the CSV, where a header scrolls off', () => {
    const records = parseCsv(planToCsv(narrowed()));
    const scope = records.find((record) => record[0] === 'Scope');

    expect(scope?.[1]).toContain('what one reader had on screen, not the whole plan — 2 of 6 rows');
  });

  /**
   * The doctrine this change must not quietly reverse (R10 §9's Q3): the four
   * exports that have always existed take every row and say nothing about a
   * scope, because there is nothing to say.
   */
  it('leaves a whole-plan export with no Scope line at all', () => {
    expect(planToMarkdown(plan({ rows: [row({ id: 'a', number: '010' })] }))).not.toContain(
      '**Scope:**',
    );
  });

  it('files itself under a name nobody can confuse with the whole plan', () => {
    expect(planFileName(narrowed(), 'md')).toBe('rewire-the-shed-2026-08-07-on-screen.md');
    expect(planFileName(plan(), 'md')).toBe('rewire-the-shed-2026-08-07.md');
  });
});
