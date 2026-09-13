import { addCalendarDays, addWorkdays, type IsoDate } from '@wbs/domain/workday';

import { calendarScale } from './gantt-geometry';
import {
  type ExportRow,
  type ExportSlice,
  markdownHeaderLines,
  markdownTableLines,
  nameOf,
  type PlanExport,
} from './plan-export';

/**
 * What a caller gets back: a diagram, or a sentence saying why there is none.
 *
 * A union rather than a string, and the refusal is the reason. The one caller
 * is a **Copy** button, and a copy that puts `This plan is not on a calendar…`
 * on the clipboard has handed somebody a document to paste into an issue —
 * exactly the failure this whole export is written against, since a pasted
 * document outlives the screen it came off. The caller has to be able to tell
 * the two apart before it chooses between the clipboard and a toast, and a
 * modelled refusal carrying its own sentence is how this codebase already says
 * so — `FLOOR_SENTENCE`, `NO_SCHEDULE`, `capacityRefusalSentence`.
 */
export type MermaidExport =
  | { readonly drawn: true; readonly text: string }
  | { readonly drawn: false; readonly refusal: string };

/**
 * What a plan with no start date is told, instead of a diagram.
 *
 * A Mermaid gantt has one axis and it is a calendar. There is no `day 3` in the
 * grammar — the CSV falls back to day offsets from day zero and this cannot —
 * and the alternative, drawing the plan from an invented epoch, puts dates
 * nobody agreed to into a document that will be read long after whoever
 * exported it has forgotten which Monday the tool picked.
 */
export const NOT_ON_A_CALENDAR =
  'This plan is not on a calendar. Set a start date — a Mermaid gantt has no way to draw a day offset.';

/** What a plan be-01 could not order is told. Every bar would stand on day zero. */
export const NO_SCHEDULE_TO_DRAW =
  'These dependencies run in a circle, so no dates could be worked out and there is no diagram to draw.';

/** What a plan nothing has been placed in is told, rather than an empty fence. */
export const NOTHING_PLACED =
  'Nothing in this plan has been scheduled yet, so there is no diagram to draw.';

/** What a work item with no name of its own is called on a bar. Never a blank. */
const UNNAMED_ROW = '(unnamed)';

/** What a project with no name is called in the diagram's title. */
const UNNAMED_PROJECT = 'Plan';

/** What a slice under no step at all is called — reachable on a project holding no steps. */
const NO_STEP = 'no step';

/** What a slice nobody is named on is called, under `assignee` sectioning. */
const UNASSIGNED = 'unassigned';

/**
 * What a `section` line groups tasks by — M3 of the R7 brief.
 *
 * Mermaid has exactly one grouping channel and it is flat (§2 row 4 of the
 * brief), so every mode spends it on a different one of the three things a
 * reader might want bars grouped by:
 *
 * - `outline` (the default, M1's own choice) — the plan's own outline, this
 *   row's outermost ancestor. Needs no new concept and matches the order the
 *   plan is already read in.
 * - `step` — the step a bar is estimated under (`Dev`, `QA`, …), this
 *   codebase's own word for it (`steps-panel.tsx`).
 * - `assignee` — who is on the bar. The brief's argument for this one: our
 *   chart spends its colour channel on people (`PERSON_BAR_COLORS`) and
 *   Mermaid has no per-task colour at all, only a `section0..3` class cycling
 *   by section index — grouping by assignee is the one way this document can
 *   partially recover that lane structure, the same one
 *   `refs/gantt/gantt_chart_v2.py` was built around.
 *
 * An array rather than a hand-written union, so the three the type admits and
 * the three a control can offer or a browser can have remembered are one list:
 * {@link isSectionMode} is the boundary check the toolbar's picker reads
 * storage through, and a fourth mode added to a union alone would be a mode no
 * control offers and no stored answer is allowed to name.
 */
export const SECTION_MODES = ['outline', 'step', 'assignee'] as const;
export type SectionMode = (typeof SECTION_MODES)[number];

/** What a caller gets who does not ask — M1's own behaviour, unchanged. */
export const DEFAULT_SECTION_MODE: SectionMode = 'outline';

/**
 * Whether `claimed` is one of the three groupings — the boundary check for a
 * mode read back out of a browser's storage or off a `<select>`'s value.
 *
 * `readonly string[]` rather than a cast on `claimed`: the array is `as const`,
 * so `includes` would otherwise refuse every string that is not already one of
 * the three, which is exactly the question being asked.
 */
export function isSectionMode(claimed: unknown): claimed is SectionMode {
  return typeof claimed === 'string' && (SECTION_MODES as readonly string[]).includes(claimed);
}

/**
 * The character a colon in somebody's text becomes: U+2236 RATIO.
 *
 * Mermaid's gantt lexer reads a task line as `[^:\n]+` and then everything from
 * the **first** colon as metadata (`gantt.jison`). A work item called
 * `Step 1: strip` therefore does not break the diagram — it silently moves that
 * split, and the reader is handed a task called `Step 1` whose id is
 * `strip` and whose dates are gone. A homoglyph rather than ` - `, because the
 * name is the one part of this document a person typed and it should read back
 * the way they typed it.
 */
const RATIO = '∶';

/**
 * One phrase of somebody's text, safe to stand left of Mermaid's colon.
 *
 * Three rules and deliberately not a fourth. The colon moves the split, a line
 * break ends the line halfway through a name, and `%%` opens a comment that
 * eats the rest of the line — the gantt lexer's comment rule is not anchored to
 * the start of one. A comma, a `#` and a `;` are left alone: they terminate
 * _metadata_, and nothing anybody typed reaches the metadata position. Ids are
 * generated (`s1`, `s2`, …) and dates are `YYYY-MM-DD` from be-01's own numbers,
 * which is the same rule the CSV writer follows for a different reason — escape
 * what the grammar reads, and nothing else, or the export prints names nobody
 * wrote.
 *
 * **Reasoned against `gantt.jison` as quoted in the R7 brief, not watched
 * against a parse.** A real Mermaid parse in the suite is M5 and is not in this
 * change; until it lands, this function is an argument.
 */
function mermaidPhrase(value: string): string {
  return value
    .replaceAll(':', RATIO)
    .replaceAll('%%', '%')
    .replaceAll(/[\r\n]+/g, ' ')
    .trim();
}

/** One line of comment prose, with the one thing that would end it early removed. */
function mermaidComment(value: string): string {
  return value.replaceAll(/[\r\n]+/g, ' ').trim();
}

/** `010.1 Strip cables`, the way every cross reference in an export names a row. */
function namedRow(row: ExportRow): string {
  return `${row.number} ${row.name.trim() === '' ? UNNAMED_ROW : row.name}`;
}

/**
 * The row a section is titled after: this row's outermost ancestor.
 *
 * Mermaid has exactly one grouping channel and it is flat, so it is spent on
 * the plan's own outline — the grouping the reader already reads the plan in.
 * The number carries the rest of the depth, which is the export's standing rule
 * (`plan-export.ts`, "the table stays flat").
 *
 * The walk is bounded by a seen set rather than by trust. `plan.rows` is every
 * row of the plan, so a chain always terminates at a root — but this file is
 * handed a document, not a tree, and a `parentId` loop in one would hang the
 * copy button rather than print a wrong section.
 */
function outermost(row: ExportRow, byId: ReadonlyMap<string, ExportRow>): ExportRow {
  const seen = new Set<string>([row.id]);
  let at = row;
  for (;;) {
    const parent = at.parentId === null ? undefined : byId.get(at.parentId);
    if (parent === undefined || seen.has(parent.id)) return at;
    seen.add(parent.id);
    at = parent;
  }
}

/** Why a slice is drawn as a point rather than as a span. */
type PointReason = 'unestimated' | 'zero';

/**
 * What each reason is called on the task that carries it.
 *
 * Kept apart because they are not the same fact. Nobody having estimated a pair
 * is a hole in the plan; somebody having estimated it at zero is an answer. The
 * chart draws the first dashed with a `?` beside it and Mermaid has neither
 * mark, so the difference has to survive as words or not at all.
 */
const POINT_WORDS: Record<PointReason, string> = {
  unestimated: 'not estimated',
  zero: '0 days',
};

/**
 * Where one slice's bar sits in the grouping `sectionMode` asked for, and what
 * its section is called.
 *
 * `order` is a sort key, not a display value: `outline` reuses the row's own
 * position (subtrees are already contiguous in `plan.rows`, which is what let
 * M1's original sort work with no separate grouping key at all), while `step`
 * and `assignee` group by the step's or the person's position in the plan's
 * own list — the same order the chart and the pickers already show them in —
 * with the ungrouped case (no step, nobody named) sorted **last**, after every
 * named group, rather than interleaved among them.
 */
function sectionOf(
  mode: SectionMode,
  plan: PlanExport,
  row: ExportRow,
  slice: ExportSlice,
  byId: ReadonlyMap<string, ExportRow>,
  rowOrder: ReadonlyMap<string, number>,
  stepOrder: ReadonlyMap<string, number>,
  personOrder: ReadonlyMap<string, number>,
): { order: number; label: string } {
  switch (mode) {
    case 'outline':
      return {
        order: rowOrder.get(row.id) ?? 0,
        label: mermaidPhrase(namedRow(outermost(row, byId))),
      };
    case 'step':
      return slice.stepId === null
        ? { order: plan.steps.length, label: NO_STEP }
        : {
            order: stepOrder.get(slice.stepId) ?? plan.steps.length,
            label: mermaidPhrase(nameOf(plan.steps, slice.stepId)),
          };
    case 'assignee':
      return slice.personId === null
        ? { order: plan.people.length, label: UNASSIGNED }
        : {
            order: personOrder.get(slice.personId) ?? plan.people.length,
            label: mermaidPhrase(nameOf(plan.people, slice.personId)),
          };
  }
}

/** One slice resolved onto the calendar, with everything its line needs. */
interface MermaidTask {
  section: string;
  text: string;
  id: string;
  critical: boolean;
  /** Whether the row is done, which Mermaid draws with its own `done` tag. */
  done: boolean;
  from: IsoDate;
  /** The last day the work is still on — see {@link planToMermaid} on `inclusiveEndDates`. */
  to: IsoDate;
  point: PointReason | null;
}

/**
 * What one bar is called: its row, its step, and whose it is.
 *
 * **No team name.** Not an omission: R2 is rewriting `ServiceTeamLabel` into
 * `teams[]` and `services[]` this week, and a team on a bar here would make this
 * change wait for it. The person is the more useful token in the space anyway —
 * the chart spends its colour channel on people and Mermaid has no colour to
 * spend — and the exported table carries the team either way.
 */
function taskTextOf(
  plan: PlanExport,
  row: ExportRow,
  slice: ExportSlice,
  point: PointReason | null,
) {
  const step = slice.stepId === null ? NO_STEP : nameOf(plan.steps, slice.stepId);
  const person = slice.personId === null ? null : nameOf(plan.people, slice.personId);
  const head = `${namedRow(row)} - ${step}`;
  return mermaidPhrase(
    [
      person === null ? head : `${head} (${person})`,
      ...(point === null ? [] : [POINT_WORDS[point]]),
    ].join(' - '),
  );
}

/**
 * Every slice of the plan as a dated task, grouped and ordered by
 * `sectionMode` — row order then step order within each group.
 *
 * **The dates are the chart's own reading, not a second one.** `calendarScale`
 * is what the Gantt places its bars with, and its docstring records four
 * watched faults from getting `endOf` wrong — including an origin two days
 * early that moved every mark on the drawing. Re-deriving the same arithmetic
 * here would be a fifth chance at those four.
 *
 * Then **rounded outward**: a start floors and a finish ceils, so no bar is
 * drawn shorter than the work in it. A slice is `effort / width` workdays and
 * can be a fraction (`3.6666666666666665` is asserted verbatim in
 * `plan-export.test.ts`); a Mermaid day is atomic.
 *
 * `to` is clamped up to `from`, which is `lastWorkdayOf`'s own clamp and the
 * only thing standing between a zero-length slice and a bar that ends the day
 * before it starts: `endOf(f)` for a whole `f` reads the *left* limit of that
 * workday, so at `earliestStart === earliestFinish` it lands a day behind the
 * start.
 *
 * **The sort's primary key is the section's own order, not the row's.** Under
 * `outline` those coincide — `plan.rows` is already a depth-first walk, so a
 * subtree is contiguous and sorting by the row's own position groups it for
 * free, which is why M1 needed no separate grouping key. `step` and
 * `assignee` scatter a section's slices across the row list (a `Dev` slice on
 * row 3 and another on row 40 belong to the same section), so those two sort
 * by the section's position first and fall back to row order, then step
 * order, only inside it — otherwise Mermaid would see the same section name
 * repeated non-contiguously and draw it as separate bands.
 */
function tasksOf(plan: PlanExport, startDate: IsoDate, sectionMode: SectionMode): MermaidTask[] {
  const byId = new Map(plan.rows.map((row) => [row.id, row]));
  const rowOrder = new Map(plan.rows.map((row, at) => [row.id, at]));
  const stepOrder = new Map(plan.steps.map((step, at) => [step.id, at]));
  const personOrder = new Map(plan.people.map((person, at) => [person.id, at]));
  const scale = calendarScale(startDate);
  // The same normalisation `calendarScale` makes of its own origin: a project
  // whose start date lands on a weekend begins on the Monday. Two origins would
  // stand every date on this diagram a day or two off the ones the table prints.
  const origin = addWorkdays(startDate, 0);
  const placed = plan.slices
    .flatMap((slice) => {
      const row = byId.get(slice.workItemId);
      // A slice whose row is not in the document is dropped rather than drawn
      // under a section it has no title for. `plan.rows` is *every* row of the
      // plan, so this is unreachable from `planForExport`; it is here because a
      // dropped bar is a smaller wrong answer than a thrown copy button.
      return row === undefined ? [] : [{ slice, row }];
    })
    // The section resolved **once per slice**, before the sort. It was called
    // twice per comparison — and in `outline` mode `sectionOf` walks the row's
    // ancestors, so an N log N sort was doing 2 N log N tree walks — and a
    // third time per slice below, for the label. Same order, same labels: the
    // function is pure over the arguments it is given here.
    .map((placement) => ({
      ...placement,
      section: sectionOf(
        sectionMode,
        plan,
        placement.row,
        placement.slice,
        byId,
        rowOrder,
        stepOrder,
        personOrder,
      ),
    }))
    .sort(
      (a, b) =>
        a.section.order - b.section.order ||
        (rowOrder.get(a.row.id) ?? 0) - (rowOrder.get(b.row.id) ?? 0) ||
        (a.slice.stepId === null ? plan.steps.length : (stepOrder.get(a.slice.stepId) ?? 0)) -
          (b.slice.stepId === null ? plan.steps.length : (stepOrder.get(b.slice.stepId) ?? 0)) ||
        a.slice.earliestStart - b.slice.earliestStart ||
        a.slice.id.localeCompare(b.slice.id),
    );
  return placed.map(({ slice, row, section }, at): MermaidTask => {
    const point: PointReason | null = !slice.estimated
      ? 'unestimated'
      : slice.duration === 0
        ? 'zero'
        : null;
    const first = Math.floor(scale.startOf(slice.earliestStart));
    const last = Math.max(first, Math.ceil(scale.endOf(slice.earliestFinish)) - 1);
    // A done row's slice stops at its fact end where it has one, as the chart's
    // done bar does (ADR 0024) — and starts no later than it stops, so a plan
    // that drifted whole past the fact still draws the fact's one day.
    const done = row.status === 'done';
    const plannedTo = addCalendarDays(origin, last);
    const to = done && row.factEnd !== null && row.factEnd < plannedTo ? row.factEnd : plannedTo;
    const plannedFrom = addCalendarDays(origin, first);
    const from = plannedFrom < to ? plannedFrom : to;
    return {
      section: section.label,
      text: taskTextOf(plan, row, slice, point),
      // Generated, and that is what keeps every user-typed character out of the
      // metadata position: an id taken from a name would collide the moment two
      // rows share a step, and one taken from `slice.id` would carry be-01's
      // opaque keys into a document a person reads.
      id: `s${String(at + 1)}`,
      critical: slice.critical,
      done,
      from,
      to,
      point,
    };
  });
}

/**
 * One task line: `name :tags, id, from, to`.
 *
 * A point carries the `milestone` tag and **still carries both dates**, equal,
 * rather than the `0d` duration the docs use. That is the second grammar trap
 * of this change paying for itself: `manualEndTime` is set by an end that parses
 * as a literal `YYYY-MM-DD`, and a duration does not, so a `0d` milestone would
 * be the one shape on the diagram that `excludes weekends` is still free to
 * move. Equal dates make the invariant uniform — every task here has a manual
 * end — and a `milestone` is drawn as a point whatever its span.
 */
function taskLine(task: MermaidTask): string {
  const tags = [
    ...(task.critical ? ['crit'] : []),
    ...(task.done ? ['done'] : []),
    ...(task.point === null ? [] : ['milestone']),
  ];
  return `    ${task.text} :${[...tags, task.id, task.from, task.to].join(', ')}`;
}

/**
 * The comment block inside the fence: what this is, and the three things a
 * reader has to know before believing it.
 *
 * Inside the fence rather than above it because a fence is what gets copied.
 * Invisible once rendered, which is the honest limit of M1 and the whole reason
 * the bundled document (M2) exists: this block is for whoever reads the source.
 */
function commentLines(plan: PlanExport): string[] {
  return [
    `    %% ${mermaidComment(plan.projectName)} — exported from the WBS tool at ${plan.generatedAt}.`,
    "    %% Mermaid's gantt is a weaker drawing than the chart this came from. It has no way to",
    '    %% draw dependency arrows, capacity or hand-off waits, slack, priority, the three-point',
    '    %% figures, how many people a work item ran at, or one colour per assignee. Copy as',
    '    %% Markdown puts every one of those in a table beside this picture.',
    '    %% Dates are working days and bars are whole days — a start rounds down and a finish',
    '    %% rounds up, so no bar is drawn shorter than the work in it.',
    // The claim the fence makes about its own completeness, and it is only true
    // of a whole-plan export. A filtered one says which rows it holds instead —
    // the same sentence its `Scope` header line carries, said again here
    // because a fence is what gets copied out of the document and pasted
    // somewhere the header is not.
    plan.scope === undefined
      ? '    %% Every row of the plan is here, including any the screen had collapsed or searched away.'
      : `    %% Only what one reader had on screen is here — ${String(plan.rows.length)} of ${String(plan.scope.totalRows)} rows. The rest of the plan is not drawn.`,
  ];
}

/**
 * A plan as a Mermaid `gantt` fence: the chart, in something a Markdown reader
 * draws.
 *
 * **Absolute dates, never `after`.** Mermaid's `after` is a layout instruction —
 * it would recompute the schedule, knowing nothing about capacity floors, person
 * floors, step order or not-before dates — so a diagram laid out by it would
 * silently disagree with be-01 on exactly the plans where the disagreement
 * matters. be-01 has already solved this schedule; the fence renders it. Same
 * rule the CSV follows: the export computes nothing, so it cannot disagree with
 * the table it came off.
 *
 * **The two grammar traps, both taken:**
 *
 * - `excludes weekends` normally *extends* a task past every excluded day it
 *   spans, which would push every bar here — our dates already skip weekends.
 *   It does not fire, because `checkTaskDates` returns early on a task whose end
 *   parsed as a literal `YYYY-MM-DD` (`ganttDb.js`, `manualEndTime`), and every
 *   task above has one. So the keyword is left doing the one thing we want:
 *   painting the weekend bands.
 * - Mermaid's end dates are **exclusive** unless `inclusiveEndDates` is
 *   declared, and `to` above is the last day the work is still on. Without that
 *   one line every bar in the document is a day short.
 *
 * Both are read off Mermaid's own source as quoted in the R7 brief and **not
 * watched against a parse** — a real Mermaid parse in the suite is M5 and is
 * deliberately not in this change, so the two claims are arguments about a
 * dependency this repo does not have yet.
 *
 * **Deterministic.** No clock and no map iterated in object-identity order: the
 * same plan and the same `generatedAt` produce the same bytes, which is what
 * makes the output diffable wherever it is pasted.
 *
 * `sectionMode` picks what a `section` line groups tasks by — see
 * {@link SectionMode}. Defaults to `outline`, M1's own behaviour, so every
 * existing caller draws exactly what it always did.
 *
 * @throws Whatever `addWorkdays` throws when `startDate` is not a calendar
 * date — a scale that cannot say where day zero is has no answer for any mark.
 */
export function planToMermaid(
  plan: PlanExport,
  sectionMode: SectionMode = DEFAULT_SECTION_MODE,
): MermaidExport {
  if (plan.scheduleError !== null) return { drawn: false, refusal: NO_SCHEDULE_TO_DRAW };
  if (plan.startDate === null) return { drawn: false, refusal: NOT_ON_A_CALENDAR };
  const tasks = tasksOf(plan, plan.startDate, sectionMode);
  if (tasks.length === 0) return { drawn: false, refusal: NOTHING_PLACED };
  // A `title` with nothing after it is a parse error rather than an untitled
  // diagram, so the one project state that can produce one has a word.
  const title = mermaidPhrase(plan.projectName);
  const lines = [
    'gantt',
    `    title ${title === '' ? UNNAMED_PROJECT : title}`,
    '    dateFormat YYYY-MM-DD',
    '    inclusiveEndDates',
    '    excludes weekends',
    ...commentLines(plan),
  ];
  let section: string | null = null;
  for (const task of tasks) {
    if (task.section !== section) {
      section = task.section;
      lines.push(`    section ${section}`);
    }
    lines.push(taskLine(task));
  }
  return { drawn: true, text: `${lines.join('\n')}\n` };
}

/**
 * A fence long enough that nothing inside `body` can end it early.
 *
 * A work item's name is free text (`ExportRow.name`), `mermaidPhrase` never
 * touches a backtick, and there is nothing in the gantt grammar that would —
 * so a name like `` `oops` `` sitting inside a plain triple-backtick fence
 * would close it early and spill the rest of the diagram into the document as
 * ordinary prose. One more backtick than the longest run already in the text
 * is what keeps the fence unambiguous, the same rule GitHub's own renderer
 * uses for a fenced block nested in another.
 */
function fenceFor(body: string): string {
  const runs = body.match(/`+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * The one line Q6 of the R7 brief asked for: which rows are in this document,
 * since the chart on screen and this document do not agree. `gantt-panel.tsx`
 * draws `shownRows` — a collapsed branch or a running search narrows it — and
 * this document draws `plan.rows`, every row, the export's own doctrine
 * (`plan-export.ts`, `planForExport` at `wbs-table.tsx`: "so a collapsed
 * branch and a running search" cannot hand somebody a plan with rows
 * missing). Without this line the first bug report is "the export added rows".
 */
const SCOPE_FIELD = {
  key: 'Scope',
  value:
    'the whole plan, not what is on screen — every row and slice, including any a collapsed branch or a running search had hidden. The chart above may draw fewer.',
};

/**
 * The bundled document: the header block, the Mermaid fence, then the table
 * `planToMarkdown` already writes — the diagram with its own footnotes. The
 * fence draws no dependency arrows, no capacity or hand-off waits, no slack
 * and no priority; the table under it is where every one of those already
 * lives, so the bundle is what makes the picture's losses honest rather than
 * merely admitted.
 *
 * Refuses exactly where {@link planToMermaid} refuses, and for the same
 * reason: a document is the fence plus the table beneath it, and there is
 * nothing to bundle around a sentence. The caller — a **Download as Markdown
 * document** action, not wired in this change (see `verify.md`) — shows the
 * same refusal a **Copy as Mermaid** click already does.
 *
 * `sectionMode` passes straight through to {@link planToMermaid}; the table
 * beneath the fence is unaffected either way, since `markdownTableLines` reads
 * `plan.rows` directly and has no `section` concept of its own.
 */
export function planToMermaidDocument(
  plan: PlanExport,
  sectionMode: SectionMode = DEFAULT_SECTION_MODE,
): MermaidExport {
  const diagram = planToMermaid(plan, sectionMode);
  if (!diagram.drawn) return diagram;
  const body = diagram.text.replace(/\n$/, '');
  const fence = fenceFor(body);
  const lines = [
    // The whole-plan sentence only where it is true. A document carrying a
    // {@link PlanExport.scope} already prints a `Scope` line of its own saying
    // which rows it holds, and two `Scope` lines — one of them claiming every
    // row — is precisely the export Q3 refused to let anybody send.
    ...markdownHeaderLines(plan, plan.scope === undefined ? [SCOPE_FIELD] : []),
    '',
    `${fence}mermaid`,
    body,
    fence,
    '',
    ...markdownTableLines(plan),
    '',
  ];
  return { drawn: true, text: lines.join('\n') };
}
