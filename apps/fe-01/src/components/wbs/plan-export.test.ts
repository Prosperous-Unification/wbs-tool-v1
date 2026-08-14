import { PluralMembershipError } from '@wbs/domain/effective-set';
import { describe, expect, it } from 'vitest';

import {
  type ExportRow,
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
  estimates: {},
  finalDays: {},
  finalTotal: 0,
  dependsOn: [],
  startNoEarlierThan: null,
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
      'Not before',
      'Starts',
      'Ends',
      'Slack',
      'Notes',
    ]);
    expect(csvColumns(planToCsv(plan({ method: 'optimistic' })))).toContain(
      'Dev final (optimistic)',
    );
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

  it('refuses to print one of two teams as if it were the answer', () => {
    // `resource-model` caps every write at one team, so a plural set here means
    // a be-01 from a later release than this client. A document is the worst
    // possible place to guess: it is read as the answer, filed, and mailed on.
    // R2-3 is the change that prints the whole set and deletes this case.
    //
    // Proof: `soleMemberOf`'s length check removed, so it answers
    // `memberIds[0]`, and this failed on `AssertionError: expected function to
    // throw an error, but it didn't` — 1 failed | 38 passed — while the CSV came
    // back naming `Billing, Ltd` alone for a row on two teams. Watched
    // 2026-08-14.
    const rows = [row({ id: 'a', number: '010', teamIds: ['team-billing', 'team-gone'] })];

    expect(() => planToCsv(plan({ rows }))).toThrow(PluralMembershipError);
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
  /** A placed slice as the export needs one: whose row, how wide, how much work. */
  const slice = (workItemId: string, width: number, effort: number) => ({
    workItemId,
    width,
    effort,
    duration: effort / width,
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
    // Proof: `teamsInForce` pointed at `plan.rows.filter((r) => r.teamIds.length
    // > 0)` rather than at every row, so an unlabelled row is simply not
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
});
