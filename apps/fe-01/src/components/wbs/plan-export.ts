import { type EffectiveServices, effectiveServicesOf } from '@wbs/domain/effective-service';
import { type EffectiveTags, effectiveTagsOf } from '@wbs/domain/effective-tag';
import { type EffectiveTeams, effectiveTeamsOf } from '@wbs/domain/effective-team';
import { priorityBandOf } from '@wbs/domain/priority-band';

import type { EstimateMethod, PriorityBandView, SliceView } from '@/lib/wbs-api';

/** One estimate's three points, as a row carries them into an export. */
export interface ExportTrio {
  optimistic: number;
  realistic: number;
  pessimistic: number;
}

/**
 * One work item, in the shape the export reads it.
 *
 * A structural subset of the table's `TreeRow` — deliberately, so the table
 * hands its rows straight over without building a second object per row — and
 * a plain one: no children, because the export is flat and the number carries
 * the outline.
 *
 * `estimates` and `finalDays` are `| undefined` on purpose. **A role a row was
 * never estimated for is absent from both**, and that absence is what the
 * export renders as an empty cell rather than a zero.
 */
export interface ExportRow {
  id: string;
  /**
   * The row above this one, or null at the root.
   *
   * Carried for one reason: a team label reaches down. `effectiveTeamsOf` walks
   * these to answer which team's people a row's work belongs to, and the export
   * prints both that answer and the label the row itself stores — an export
   * that showed moved dates and not the pool that moved them is the CSV
   * equivalent of a bare newline.
   */
  parentId: string | null;
  number: string;
  name: string;
  notes: string;
  /** True when the figures below are sums of the rows beneath rather than typed. */
  rolledUp: boolean;
  /** The teams this row states, 0..n. Empty inherits; see `effectiveTeamsOf`. */
  teamIds: readonly string[];
  /** The tags this row states, 0..n. Empty inherits; see `effectiveTagsOf`. */
  tagIds: readonly string[];
  /**
   * The services this row states, 0..n. Empty inherits; see `effectiveServicesOf`.
   *
   * Plural since the 2026-08-21 scope change, and the field the third dimension
   * enters this document by. Required rather than optional for the reason the
   * `priority` comment in the test fixture records at length: an optional field
   * is a field every caller may forget, and a forgotten label column exports as
   * blank rather than as a failure.
   */
  serviceIds: readonly string[];
  estimates: Record<string, ExportTrio | undefined>;
  finalDays: Record<string, number | undefined>;
  finalTotal: number;
  /** By id — resolved to work item numbers here, because an id is not readable. */
  dependsOn: readonly string[];
  startNoEarlierThan: string | null;
  /**
   * Why that date is there, in the planner's own words, or null where nobody
   * has said.
   *
   * Its own column rather than a suffix on the date, which is how every other
   * piece of row text is carried here: a spreadsheet reader sorts and filters
   * on `Not before` as a date, and a cell reading `2026-09-12 — waiting on
   * client sign-off` is a date column that has stopped being one. `Notes`'
   * shape exactly, and it goes through the same `csvField` and `markdownCell`
   * escaping — a reason may hold commas, quotes and pipes like any sentence.
   *
   * **Optional, and nothing fills it yet.** `planForExport` in `wbs-table.tsx`
   * builds these rows and was another agent's file to edit while this was
   * written — the one line it owes is
   * `startNoEarlierThanReason: row.original.startNoEarlierThanReason`, beside
   * the `startNoEarlierThan` above it. Until that lands the column is exported
   * empty on every row, which is what it will read on every plan nobody has
   * explained anyway.
   */
  startNoEarlierThanReason?: string | null;
  /** The priority somebody gave this work — 1 upward, smaller first — or null. */
  priority: number | null;
  /**
   * How many people may work on this item at once, as somebody typed it.
   *
   * The **stored** number. What the engine could actually give it is
   * {@link ExportSlice.width}, and the export carries both because they differ
   * for two reasons a reader has no other way to learn: the team was smaller
   * than the number, or somebody is named on the work.
   */
  maxParallel: number;
  dates: { startsOn: string; endsOn: string } | null;
  schedule: { earliestStart: number; earliestFinish: number; float: number; critical: boolean };
  assignees: Record<string, string | undefined>;
  doesEveryPhase: string | null;
}

/**
 * One placed slice, as far as the export is concerned: whose row, and how wide
 * be-01 actually ran it.
 *
 * The compression lives here and not on the row: a row's duration is
 * `effort / width`, and without {@link ExportSlice.width} the CSV shows a
 * two-day row carrying six days of estimate and says nothing about why. `width`
 * is what the `Ran at` column reads, as a set per row.
 *
 * **`effort` is carried and read by nothing.** C3's own cross-review recorded it
 * (2026-08-13, P3) against a docstring that claimed all three did work. It is
 * not lost information — `Total days` is the effort and `Starts`/`Ends` are the
 * span — so the honest fix was this paragraph rather than deleting a field the
 * producer would then stop filling: `capacity-docs`, D6. `duration` stopped
 * being one of the unread two when `plan-mermaid.ts` began asking which slices
 * are points rather than spans.
 *
 * **This is be-01's `SliceView` and not a narrowing of it, since
 * `mermaid-gantt`.** It always was one at runtime — `planForExport` assigns
 * `chartRead.slices` verbatim (`wbs-table.tsx`) — and the four-field interface
 * that used to stand here only hid the rest from the type checker. A chart
 * cannot be drawn from four fields: `planToMermaid` needs the role, the person,
 * the offsets, the critical flag and whether anybody estimated the pair, and
 * every one of them was already in the object. Widening was therefore a change
 * with no new plumbing and no second request, which is the cheapest kind.
 *
 * The alias rather than a hand-written superset: two lists of the same fields
 * drift, and the drift would land as an export quietly disagreeing with the
 * chart about a slice both are reading out of the same array.
 */
export type ExportSlice = SliceView;

/**
 * What a document that is **not** the whole plan is a document of.
 *
 * Present only on an export of the rows one reader had on screen (R10 F5), and
 * absent — not empty, absent — on every other, which is what keeps the four
 * existing exports byte-for-byte what they were: they take `flat`, they say so
 * in the bundled document's `Scope` line, and that doctrine is settled (§9's
 * Q3).
 *
 * `criteria` is `filterWords`' list (`tree-search.ts`), so the document's
 * account of what was filtered is the filter's own account of itself rather
 * than a second one written here. Empty means the rows were narrowed by a
 * collapsed branch alone, which is a real way to have fewer rows on screen and
 * has to read differently from a filter that kept them out.
 */
export interface FilteredScope {
  /** How many rows the whole plan holds — how many are in the document is `rows.length`. */
  totalRows: number;
  criteria: readonly string[];
}

/**
 * How many `depends on` references in this document point at a work item the
 * document does not hold.
 *
 * The document's own count of its own holes, taken from `plan.rows` and nothing
 * else: a filtered export drops rows, the Depends on column resolves a
 * predecessor by looking it up among the rows it has, and an unresolvable one
 * prints as nothing at all. Silent on screen is one thing — the chart says what
 * it did not draw (F3) — and silent in a file somebody was **sent** is the bug
 * this whole scope line exists to close.
 *
 * Zero on a whole-plan export by construction, which is why nothing reads it
 * there.
 */
function danglingDependencies(plan: PlanExport): number {
  const held = new Set(plan.rows.map((row) => row.id));
  return plan.rows.reduce(
    (missing, row) => missing + row.dependsOn.filter((id) => !held.has(id)).length,
    0,
  );
}

/** A role, team or person as the export needs it: something with a name to print. */
export interface NamedEntry {
  id: string;
  name: string;
}

/**
 * A whole plan, ready to be written out.
 *
 * Every id in it resolves against the lists in the same object — this is a
 * self-contained document, not a view onto live state, which is what lets both
 * writers be pure.
 */
export interface PlanExport {
  projectName: string;
  /**
   * When this export was taken, as the caller's clock said it.
   *
   * Passed in rather than read here: a function that calls `Date.now()` cannot
   * be tested for the sentence it prints. The app passes an ISO UTC instant,
   * so the header is unambiguous about which day it means.
   */
  generatedAt: string;
  method: EstimateMethod;
  /** The day the plan starts, or null while it is not on a calendar at all. */
  startDate: string | null;
  /** `cycle` when be-01 could not order the graph, and so has no schedule to report. */
  scheduleError: 'cycle' | null;
  roles: readonly NamedEntry[];
  teams: readonly NamedEntry[];
  /** The tag vocabulary, for the Tags column — `teams`' shape, one dimension over. */
  tags: readonly NamedEntry[];
  /**
   * The service vocabulary, for the Services column — `tags`' shape again.
   *
   * A **plan-level list** and not the directory's: an export is self-contained
   * (see this interface's own note), so a service renamed after the CSV was
   * taken leaves the CSV saying what it said on the day.
   */
  services: readonly NamedEntry[];
  /**
   * What this plan calls its priority numbers, for the Priority band column.
   *
   * The **plan's own** ladder travels with the export rather than being inferred
   * from the numbers, because a spreadsheet outlives the plan it came from: a CSV
   * saying `Critical` for 10 is still readable the day somebody re-cuts the
   * ladder, and one saying only `10` is a number nobody can name again.
   */
  priorityBands: readonly PriorityBandView[];
  people: readonly NamedEntry[];
  /**
   * The work items this document holds, in tree order.
   *
   * **Every one of them** for the four exports that have always existed —
   * collapsed branches and running filters are the screen's business, not a
   * document's. The one export that takes the rows on screen instead says so in
   * {@link PlanExport.scope}, and a document with rows missing and no scope is
   * the thing Q3 refused.
   */
  rows: readonly ExportRow[];
  /**
   * What this document is of, when it is not the whole plan — see
   * {@link FilteredScope}.
   *
   * Optional so every caller that takes the whole plan stays exactly what it
   * was, and so the absence itself carries the claim: no scope line means no
   * narrowing, and there is no way to write one down without also writing down
   * what it kept.
   */
  scope?: FilteredScope;
  /**
   * Every slice be-01 placed, in its own order.
   *
   * Empty on a plan that could not be scheduled, which is the same absence the
   * dates report as {@link NO_SCHEDULE}: a parallelism column filled in from
   * nothing would be this document's own invention.
   */
  slices: readonly ExportSlice[];
}

/** The method under the name the project chose it by, never its wire value. */
const METHOD_NAMES: Record<EstimateMethod, string> = {
  pert: 'PERT',
  optimistic: 'optimistic',
  realistic: 'realistic',
  pessimistic: 'pessimistic',
};

/** What a plan with no start date says about its own dates. */
const NOT_ON_A_CALENDAR = 'not on a calendar';

/**
 * What stands in for a schedule figure that does not exist.
 *
 * A cycle leaves every row with the same zeroed schedule, and printing those
 * is a page of `day 0` that reads as "everything happens at once" — the
 * confident wrong answer the table's own banner exists to prevent.
 */
const NO_SCHEDULE = '—';

/** What an id that names nobody prints as, in the table's own words. */
const UNKNOWN_NAME = '(unknown)';

/** RFC 4180's record separator. Both writers of a CSV field agree on this one. */
const CRLF = '\r\n';

/**
 * The leading characters Excel, LibreOffice and Sheets read as the start of a
 * formula rather than as text (CSV injection, CWE-1236).
 *
 * A field starting with one of these is prefixed with an apostrophe, which
 * those readers strip back off while displaying the text. Applied to every
 * field rather than only to the typed ones: the rule is then one sentence, and
 * no exported figure is negative — days are durations, offsets count forward,
 * and slack is a late date minus an earlier one.
 */
const FORMULA_LEADERS = new Set(['=', '+', '-', '@', '\t', '\r']);

/**
 * One field, escaped for a CSV a spreadsheet will neither misread nor execute.
 *
 * Quoted when it holds a comma, a quote or a line break; quotes inside a
 * quoted field are doubled. That is RFC 4180 exactly, and it is what makes a
 * multi-line note survive as one cell.
 */
function csvField(value: string): string {
  const guarded = FORMULA_LEADERS.has(value.slice(0, 1)) ? `'${value}` : value;
  if (!/["\r\n,]/.test(guarded)) return guarded;
  return `"${guarded.replaceAll('"', '""')}"`;
}

/**
 * One cell, safe to put between two pipes.
 *
 * A pipe would open a column nobody asked for and a line break would end the
 * row halfway through, so those two are dealt with and **nothing else is**:
 * a note is Markdown source, and escaping its asterisks would export a
 * different document from the one that was written.
 */
function markdownCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll(/[\r\n]+/g, ' ');
}

/** A number as the plan holds it — full precision, not the table's one decimal. */
const showFigure = (days: number): string => String(days);

/** `entries`' name for `id`, or the table's word for an id that names nobody. */
function nameOf(entries: readonly NamedEntry[], id: string): string {
  return entries.find((entry) => entry.id === id)?.name ?? UNKNOWN_NAME;
}

/**
 * The header fields both formats carry, in one place so they cannot drift.
 *
 * This is the block codex asked for: a reader who is handed the table alone
 * has no way to know which of four methods produced the finals, whether the
 * dates are dates or offsets, or how old the figures are.
 */
function headerFields(plan: PlanExport): { key: string; value: string }[] {
  const fields = [
    { key: 'Project', value: plan.projectName },
    { key: 'Final figures', value: METHOD_NAMES[plan.method] },
    { key: 'Start date', value: plan.startDate ?? NOT_ON_A_CALENDAR },
    {
      key: 'Dates',
      value:
        plan.startDate === null
          ? 'day offsets from day zero — the plan is not on a calendar'
          : 'working days — dates skip weekends',
    },
    { key: 'Generated', value: plan.generatedAt },
    {
      key: 'Figures',
      value: 'unrounded; an empty cell means nobody has estimated it, never zero',
    },
    // What the two capacity columns mean, in the one place a reader handed the
    // table alone can find it. Without it `Ran at` is a bare number beside an
    // estimate it does not match, and the reader's only reading of a 6-day row
    // spanning 2 days is that the export is wrong.
    {
      key: 'People',
      value:
        'the figures are effort. "People at once" is what was asked for and "Ran at" is what the team had free — a row runs for its effort divided by that, so a blank means one at a time',
    },
  ];
  if (plan.scheduleError !== null) {
    fields.push({
      key: 'Schedule',
      value: `these dependencies run in a circle, so no dates could be worked out — every date and slack reads ${NO_SCHEDULE}`,
    });
  }
  // Last, and in **both** formats: a document that is not the whole plan says
  // so wherever it is read, and the CSV is the copy that ends up in a
  // spreadsheet with the header scrolled off — which is why the sentence names
  // the narrowing rather than merely admitting to one.
  if (plan.scope !== undefined) fields.push(scopeField(plan, plan.scope));
  return fields;
}

/**
 * The `Scope` line of a document that holds some of a plan: how much of it is
 * here, what kept these rows, and what the absent ones took with them.
 *
 * Three claims, and the third is the one a reader cannot recover for
 * themselves: **the figures were not recomputed.** Every date, every slack and
 * every total in a filtered export is be-01's answer for the whole plan, because
 * the schedule is computed over the whole plan whatever the screen is showing
 * (`notes/wbs-scope-2026-08-13-wave6.md:188-189`). A reader who assumed
 * otherwise would read these dates as a plan of this work alone, which would be
 * a shorter and entirely fictional project.
 */
function scopeField(plan: PlanExport, scope: FilteredScope): { key: string; value: string } {
  const kept =
    scope.criteria.length === 0
      ? 'no filter was on, so a collapsed branch is what left the rest out'
      : `kept by: ${scope.criteria.join('; ')}`;
  const dangling = danglingDependencies(plan);
  const holes =
    dangling === 0
      ? ''
      : ` ${String(dangling)} Depends on ${dangling === 1 ? 'reference points' : 'references point'} at a work item this document does not hold, and ${dangling === 1 ? 'it is' : 'they are'} blank in the table below.`;
  return {
    key: 'Scope',
    value:
      `what one reader had on screen, not the whole plan — ${String(plan.rows.length)} of ` +
      `${String(scope.totalRows)} rows, ${kept}. The figures are the whole plan's schedule ` +
      `unchanged: nothing here was recalculated from the rows that were kept.${holes}`,
  };
}

/** What a row's Starts cell says: a date, a day offset, or nothing knowable. */
function startsCell(plan: PlanExport, row: ExportRow): string {
  if (plan.scheduleError !== null) return NO_SCHEDULE;
  return row.dates?.startsOn ?? `day ${showFigure(row.schedule.earliestStart)}`;
}

/** What a row's Ends cell says. `endsOn` is the last day the work is still on. */
function endsCell(plan: PlanExport, row: ExportRow): string {
  if (plan.scheduleError !== null) return NO_SCHEDULE;
  return row.dates?.endsOn ?? `day ${showFigure(row.schedule.earliestFinish)}`;
}

/**
 * Who does one role's work on one row.
 *
 * The every-phase assumption is spelled out rather than left as a blank: the
 * table shows it in grey beside the picker, and an export that dropped it
 * would say nobody is doing the QA of a row one person is plainly doing all
 * of.
 */
function assigneeCell(plan: PlanExport, row: ExportRow, roleId: string): string {
  const assigned = row.assignees[roleId];
  if (assigned !== undefined) return nameOf(plan.people, assigned);
  if (row.doesEveryPhase === null) return '';
  return `${nameOf(plan.people, row.doesEveryPhase)} (assumed — the only assignee does every phase)`;
}

/** One column of the exported table: what it is called, and what a row puts in it. */
interface ExportColumn {
  header: string;
  cell: (row: ExportRow) => string;
}

/**
 * Which team's people each row's work is drawn from, and which row said so —
 * `libs/domain`'s one reading, not an export-shaped copy of it.
 *
 * Computed once per document rather than per cell: the walk is over the whole
 * `rows` list either way, and a per-cell call would re-walk it for each of
 * them. `rows` is **every** row of the plan (`planForExport`), so an ancestor
 * that carries the label is always in the list a leaf's chain is resolved
 * against — an export built from the rows on screen would lose the label a
 * collapsed parent holds and would then print `` where a pool is what moved
 * the dates.
 */
function teamsInForce(plan: PlanExport): ReadonlyMap<string, EffectiveTeams> {
  return effectiveTeamsOf(plan.rows);
}

/** {@link teamsInForce} for the other dimension, computed once per document. */
function tagsInForce(plan: PlanExport): ReadonlyMap<string, EffectiveTags> {
  return effectiveTagsOf(plan.rows);
}

/** {@link teamsInForce} for the third dimension, computed once per document. */
function servicesInForce(plan: PlanExport): ReadonlyMap<string, EffectiveServices> {
  return effectiveServicesOf(plan.rows);
}

/**
 * One label dimension's cell: the names in force on this row, and where they
 * were written when they were not written here.
 *
 * **One body for all three dimensions**, which is a change of shape the third
 * one forced. Team and tag carried a copy each and the copies agreed; a third
 * copy is the point at which "they agree" stops being a fact and becomes a
 * thing somebody has to keep true — and {@link tagCell} had already written
 * down that dimensions inheriting by one rule must *read* as though they do.
 * The dimensions differ in exactly two places, the vocabulary the ids resolve
 * against and the ids themselves, so those are the two parameters; everything a
 * reader of a cell sees is decided here, once.
 *
 * The **effective** labels rather than the stored ones, and the naming of the
 * source is what makes that safe: a leaf with no label of its own is on a pool
 * anyway, and an export printing a blank there is an export that cannot explain
 * its own dates. `010 Backend` is the row named the way every other cross
 * reference in this document names one — the number, which is also the Depends
 * on column's currency.
 *
 * `; `-joined, which is the separator R2-3 settles on for the `Teams` column
 * and therefore the one R3's import will match names by — one rule for all
 * three dimensions rather than three.
 */
function labelCell(
  plan: PlanExport,
  vocabulary: readonly NamedEntry[],
  effective: { ids: readonly string[]; fromId: string } | undefined,
  row: ExportRow,
): string {
  if (effective === undefined) return '';
  const name = effective.ids.map((id) => nameOf(vocabulary, id)).join('; ');
  if (effective.fromId === row.id) return name;
  const from = plan.rows.find((each) => each.id === effective.fromId);
  return from === undefined
    ? `${name} (inherited)`
    : `${name} (inherited from ${from.number} ${from.name})`;
}

/**
 * What a row's Team cell says: the team whose people did the work.
 *
 * {@link labelCell} for the reasons; this names which dimension is being read.
 */
function teamCell(plan: PlanExport, inForce: ReadonlyMap<string, EffectiveTeams>, row: ExportRow) {
  const effective = inForce.get(row.id);
  return labelCell(
    plan,
    plan.teams,
    effective && { ids: effective.teamIds, fromId: effective.fromId },
    row,
  );
}

/**
 * What a row's Tags cell says: what kind of thing the work is.
 *
 * The **effective** tags rather than the stored ones, for {@link labelCell}'s
 * reason: a leaf under a `regulatory` parent *is* regulatory, and a document
 * printing a blank there is a document that disagrees with the filter that
 * produced it.
 *
 * What the three dimensions must **not** share is a cell — a row on `Platform`,
 * `regulatory` and `Payments` answers three different questions, and one column
 * holding them would be a document saying something the model does not. Sharing
 * the *rendering* is the opposite move and the safe one.
 */
function tagCell(plan: PlanExport, inForce: ReadonlyMap<string, EffectiveTags>, row: ExportRow) {
  const effective = inForce.get(row.id);
  return labelCell(
    plan,
    plan.tags,
    effective && { ids: effective.tagIds, fromId: effective.fromId },
    row,
  );
}

/**
 * What a row's Services cell says: what is being delivered.
 *
 * **Plural, and every stated name joined** — a row delivering `Checkout` and
 * `Payments` says both, since the 2026-08-21 scope change. Printing the first
 * would be this document choosing which half of a row's own statement to
 * publish, and a spreadsheet is exactly where somebody counts the other half.
 *
 * A service is *what is being delivered*, which is why it is neither the team
 * column nor a tag: the team is who did the work, and a tag is a word about the
 * work. Three columns, three questions, one inheritance sentence.
 */
function serviceCell(
  plan: PlanExport,
  inForce: ReadonlyMap<string, EffectiveServices>,
  row: ExportRow,
) {
  const effective = inForce.get(row.id);
  return labelCell(
    plan,
    plan.services,
    effective && { ids: effective.serviceIds, fromId: effective.fromId },
    row,
  );
}

/**
 * The widths be-01 actually ran a row's slices at, as a cell.
 *
 * A **set**, joined, and not one number: width is decided per slice, so a row
 * of `maxParallel: 3` with one role assigned to somebody reads `1, 3` — that
 * role serialised and the rest not. Printing only the largest would say the
 * whole item ran three-up, and printing only the smallest would say it never
 * did.
 *
 * Empty where the plan has no slices at all, which is the same absence the
 * dates report as {@link NO_SCHEDULE}: a column filled in from nothing would be
 * this document's own invention. Also empty where every width is 1 and nobody
 * asked for more, because a column of `1`s down an ordinary plan is furniture.
 */
function ranAtCell(plan: PlanExport, row: ExportRow): string {
  const widths = [
    ...new Set(plan.slices.filter((slice) => slice.workItemId === row.id).map((s) => s.width)),
  ].sort((a, b) => a - b);
  if (widths.length === 0) return '';
  if (row.maxParallel === 1 && widths.every((width) => width === 1)) return '';
  return widths.map(showFigure).join(', ');
}

/**
 * Every column, in the order both formats print them.
 *
 * The table stays **flat**: the derived number is the outline already (`010`,
 * `010.1`), so indenting the name would say the same thing a second time and
 * would do it differently in a spreadsheet than in Markdown.
 *
 * `markSums` is the one difference between the two formats. A rolled-up row's
 * figures are sums of the rows beneath it, and Markdown says so on the figure;
 * a CSV must not, because `7 (sum)` is text where a spreadsheet wants a
 * number. The marked final identifies the row — the trio beside it is a sum in
 * the same way.
 */
function columnsOf(plan: PlanExport, markSums: boolean): ExportColumn[] {
  const method = METHOD_NAMES[plan.method];
  const inForce = teamsInForce(plan);
  const tagsHeld = tagsInForce(plan);
  const servicesHeld = servicesInForce(plan);
  /** A computed figure, with Markdown's sum marker where one applies. */
  const figure = (row: ExportRow, days: number | undefined): string => {
    if (days === undefined) return '';
    return markSums && row.rolledUp ? `${showFigure(days)} (sum)` : showFigure(days);
  };
  return [
    { header: 'Number', cell: (row) => row.number },
    { header: 'Name', cell: (row) => row.name },
    { header: 'Team', cell: (row) => teamCell(plan, inForce, row) },
    // Beside Team and not folded into it: who does the work and what kind of
    // thing it is are two questions, and one column answering both would be a
    // document making a claim the model does not.
    { header: 'Tags', cell: (row) => tagCell(plan, tagsHeld, row) },
    // Third of the three label columns and **after** Tags, which is
    // `wbs-table.tsx`'s own column order (`Service/team`, `Tags`, `Services`)
    // and `plan-cards.tsx`'s chip order. Deliberately not beside Team, where a
    // reader who saw `Billing, Ltd | Payments` would take the second for a
    // property of the first — the two are independent (Dany, 2026-08-20 23:16),
    // and one order across all three faces is what stops a spreadsheet from
    // re-arguing it.
    { header: 'Services', cell: (row) => serviceCell(plan, servicesHeld, row) },
    // The two numbers the schedule's compression is made of, beside the team
    // whose people they are counted out of. Blank at 1, the Priority column's
    // bargain: a spreadsheet reader sorting on this wants an empty cell rather
    // than a column of ones down a plan nobody has widened.
    {
      header: 'People at once',
      cell: (row) => (row.maxParallel === 1 ? '' : String(row.maxParallel)),
    },
    { header: 'Ran at', cell: (row) => ranAtCell(plan, row) },
    ...plan.roles.flatMap((role): ExportColumn[] => [
      {
        header: `${role.name} optimistic`,
        cell: (row) => {
          const trio = row.estimates[role.id];
          return trio === undefined ? '' : showFigure(trio.optimistic);
        },
      },
      {
        header: `${role.name} realistic`,
        cell: (row) => {
          const trio = row.estimates[role.id];
          return trio === undefined ? '' : showFigure(trio.realistic);
        },
      },
      {
        header: `${role.name} pessimistic`,
        cell: (row) => {
          const trio = row.estimates[role.id];
          return trio === undefined ? '' : showFigure(trio.pessimistic);
        },
      },
      {
        header: `${role.name} final (${method})`,
        cell: (row) => figure(row, row.finalDays[role.id]),
      },
      { header: `${role.name} by`, cell: (row) => assigneeCell(plan, row, role.id) },
    ]),
    {
      header: `Total days (${method})`,
      // Empty rather than `0` when no role has a figure: a total of nothing
      // estimated is not a plan that takes no time.
      cell: (row) =>
        plan.roles.some((role) => row.finalDays[role.id] !== undefined)
          ? figure(row, row.finalTotal)
          : '',
    },
    {
      header: 'Depends on',
      cell: (row) =>
        row.dependsOn
          .flatMap((id) => {
            const predecessor = plan.rows.find((each) => each.id === id);
            return predecessor === undefined ? [] : [predecessor.number];
          })
          .join(', '),
    },
    // Beside the other thing a planner writes down about when work happens.
    // Blank for a work item nobody has given a priority, exactly as the column is: a
    // spreadsheet reader sorting on this wants an empty cell, not a 0.
    { header: 'Priority', cell: (row) => (row.priority === null ? '' : String(row.priority)) },
    // The name beside the number rather than instead of it. The number is what
    // the plan sorts by and the name is what a reader of the export talks about,
    // and neither substitutes for the other: two rows at 10 and 18 are both
    // `Critical` and are not the same priority. Blank where the number is, for
    // the reason above it.
    //
    // `priorityBandOf` and not a lookup of this file's own, which is the whole of
    // "the band-to-anything mapping is one function": the table's cell, the
    // chart's bars, the cards and this column resolve a number to a band in
    // `libs/domain` and colour it in `priority-band-style.ts`, and no face holds
    // a fifth opinion. A CSV has no colour, so this reads the label alone.
    {
      header: 'Priority band',
      cell: (row) =>
        row.priority === null
          ? ''
          : (priorityBandOf(plan.priorityBands, row.priority)?.label ?? ''),
    },
    { header: 'Not before', cell: (row) => row.startNoEarlierThan ?? '' },
    // Beside the date it explains rather than inside it, so the column above
    // stays a date column. Empty where nobody has written one — and empty on
    // every row where there is no date at all, because be-01 refuses the pair.
    {
      header: 'Not before because',
      cell: (row) => row.startNoEarlierThanReason ?? '',
    },
    { header: 'Starts', cell: (row) => startsCell(plan, row) },
    { header: 'Ends', cell: (row) => endsCell(plan, row) },
    {
      header: 'Slack',
      cell: (row) => {
        if (plan.scheduleError !== null) return NO_SCHEDULE;
        return row.schedule.critical ? 'critical' : showFigure(row.schedule.float);
      },
    },
    { header: 'Notes', cell: (row) => row.notes },
  ];
}

/**
 * The header block Markdown carries, formatted as the bold `**key:** value`
 * lines both `planToMarkdown` and the bundled Mermaid document (`plan-mermaid.ts`)
 * open with.
 *
 * `extra` is appended after the header this format always carries and before
 * nothing — a caller with one more fact to state (the bundled document's own
 * `Scope` line) does not have to know where in the block it belongs.
 */
export function markdownHeaderLines(
  plan: PlanExport,
  extra: readonly { key: string; value: string }[] = [],
): string[] {
  return [
    ...headerFields(plan),
    { key: 'Rolled-up rows', value: 'a figure marked (sum) is the total of the rows beneath it' },
    ...extra,
  ].map((field) => `**${field.key}:** ${markdownCell(field.value)}`);
}

/** The table alone, as Markdown: the column headings, the rule, then one row per work item. */
export function markdownTableLines(plan: PlanExport): string[] {
  const columns = columnsOf(plan, true);
  return [
    `| ${columns.map((each) => markdownCell(each.header)).join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...plan.rows.map(
      (row) => `| ${columns.map((each) => markdownCell(each.cell(row))).join(' | ')} |`,
    ),
  ];
}

/**
 * The plan as Markdown: a header block, then one flat table.
 *
 * What the header says is the point of it — which method produced the finals,
 * whether the dates are dates, when this was taken, and that the figures are
 * the raw ones rather than the rounded ones on screen. A table pasted into a
 * document outlives the screen it came off.
 */
export function planToMarkdown(plan: PlanExport): string {
  return [...markdownHeaderLines(plan), '', ...markdownTableLines(plan), ''].join('\n');
}

/**
 * The plan as RFC 4180 CSV: the header block as leading `key,value` records,
 * a blank record, then the table.
 *
 * A comment syntax would have been the obvious place for the header, and CSV
 * has none — `#` is a convention some readers honour and others import as a
 * first column. Leading records are read by every spreadsheet there is, and
 * the blank one is what separates them from the column headings.
 *
 * No terminator after the last record: RFC 4180 leaves it optional, and a
 * trailing CRLF reads as an empty row in some importers.
 */
export function planToCsv(plan: PlanExport): string {
  const columns = columnsOf(plan, false);
  const records: string[][] = [
    ...headerFields(plan).map((field) => [field.key, field.value]),
    [],
    columns.map((each) => each.header),
    ...plan.rows.map((row) => columns.map((each) => each.cell(row))),
  ];
  return records.map((record) => record.map(csvField).join(',')).join(CRLF);
}

/** What a project with no usable characters in its name is filed under. */
const UNNAMEABLE_PROJECT = 'plan';

/**
 * The name the downloaded file lands under: the project, slugified, the day it
 * was taken, and the extension the caller asked for.
 *
 * The day comes off {@link PlanExport.generatedAt}, which is UTC — two people
 * exporting the same plan an hour either side of midnight in different
 * timezones therefore agree on the filename, and may disagree with their own
 * calendars by a day.
 *
 * `extension` defaults to `csv` so every existing caller compiles unchanged;
 * the bundled Mermaid document (`plan-mermaid.ts`) is the first to pass `md`.
 *
 * **A filtered export files itself under `-on-screen`**, off
 * {@link PlanExport.scope} and not off a flag the caller could forget to pass:
 * two documents of one plan taken on one day would otherwise land in the same
 * folder under the same name, and the one with rows missing is the one nobody
 * can tell apart afterwards.
 */
export function planFileName(
  plan: Pick<PlanExport, 'projectName' | 'generatedAt' | 'scope'>,
  extension: 'csv' | 'md' = 'csv',
): string {
  const slug = plan.projectName
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
  const narrowed = plan.scope === undefined ? '' : '-on-screen';
  return `${slug === '' ? UNNAMEABLE_PROJECT : slug}-${plan.generatedAt.slice(0, 10)}${narrowed}.${extension}`;
}
