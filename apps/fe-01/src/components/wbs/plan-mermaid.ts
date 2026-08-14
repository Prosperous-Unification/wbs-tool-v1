import { addCalendarDays, addWorkdays, type IsoDate } from '@wbs/domain/workday';

import {
  type GanttBar,
  type GanttGeometry,
  type GanttPlan,
  type GanttRowLabel,
  layOutGantt,
  type PlacedBar,
  type PlacedGantt,
  placeOnCalendar,
  type ServiceTeamLabel,
} from './gantt-geometry';

/**
 * The facts about a plan that the chart's own geometry does not carry.
 *
 * The same four the CSV's header block is built from, and passed in for the
 * same reason: {@link planToMermaid} reads no clock, so the line it writes
 * about when the export was taken is a line a test can assert.
 */
export interface MermaidPlan {
  projectName: string;
  /** When this export was taken, as the caller's clock said it — ISO UTC. */
  generatedAt: string;
  /** The day the plan starts, or null while it is not on a calendar at all. */
  startDate: IsoDate | null;
  /** `cycle` when be-01 could not order the graph, and so has no schedule to draw. */
  scheduleError: 'cycle' | null;
}

/**
 * The day a plan with no start date is drawn from.
 *
 * Mermaid's gantt has one axis and it is a calendar; there is no workday-offset
 * mode a reader's renderer can be relied on to agree about. So a plan that is
 * not on a calendar is pinned to a Monday and **says so** — in the comment
 * block inside the fence, which is what survives a copy, and in the legend
 * under it, which is what a reader of the rendered picture sees.
 *
 * 2000-01-03 is a Monday, and that is what keeps the whole diagram on working
 * days: `addWorkdays` normalises a weekend origin forward, so an origin that
 * had to be normalised would put day zero somewhere other than the date this
 * constant names.
 */
export const SYNTHETIC_ORIGIN: IsoDate = '2000-01-03';

/** What a row with no name of its own is called — the words the tree uses for it. */
const UNNAMED_ROW = '(unnamed)';

/** What a slice nobody is on is called. Never a blank: a blank reads as a dropped field. */
const NOBODY = 'unassigned';

/** What a slice under no role at all is called. */
const NO_ROLE = 'no role';

/**
 * What a team the directory read has not caught up with is called.
 *
 * The export's own word for it — `plan-export.ts` prints the same one — rather
 * than the chart's sentence: a section title is a label, and "a team this plan
 * has not loaded" is a sentence.
 */
const UNKNOWN_TEAM = '(unknown)';

/** The fence a Markdown reader needs to hand the block to Mermaid rather than render it as text. */
const FENCE = '```';

/**
 * The separator between the facts crowded into one task name or section title.
 *
 * A middle dot rather than a colon or an em dash. A colon would move the split
 * Mermaid makes on the task line (see {@link mermaidPhrase}), and the em dash is
 * already spoken for by the chart's own floor sentences, which the legend
 * quotes verbatim.
 */
const DOT = ' · ';

/**
 * One phrase, safe to stand left of Mermaid's colon.
 *
 * Mermaid's gantt splits a task line on its **first** colon: everything before
 * it is the name and everything after is the tags, the id and the dates. A
 * colon in a work item's name therefore does not break the diagram — it
 * silently moves that split, and the reader gets a task called `Dev` with an id
 * of `build :t1`. Measured against Mermaid 11.16.1's own parser, which read
 * exactly that back out of `Dev: build :t1, 2026-06-01, 2026-06-04`.
 *
 * Line breaks end the line halfway through and are collapsed for the reason a
 * Markdown cell collapses them. Nothing else is touched: a comma, a `#`, a `%`,
 * a `;` and a `<` all read back verbatim through the same parser, and escaping
 * them would export names nobody typed.
 *
 * An empty name is a parse error rather than a nameless bar — the grammar
 * refuses a task line that begins with its colon — so every caller has a word
 * to stand there instead.
 */
function mermaidPhrase(value: string): string {
  return value
    .replaceAll(':', '-')
    .replaceAll(/[\r\n]+/g, ' ')
    .trim();
}

/**
 * One line of comment prose, with the one thing that would end it removed.
 *
 * A `%%` inside a comment does not open a second one — Mermaid reads a comment
 * to the end of its line — but a newline does end it, and a project name is
 * free text somebody typed.
 */
function mermaidComment(value: string): string {
  return value.replaceAll(/[\r\n]+/g, ' ').trim();
}

/** `<number> <name>`, the way the plan names a row out loud, with the tree's word for an unnamed one. */
function namedRow(label: Pick<GanttRowLabel, 'number' | 'name'>): string {
  return `${label.number} ${label.name === '' ? UNNAMED_ROW : label.name}`;
}

/** The pool a section title names, or null where the row is on none. */
function teamNameOf(team: ServiceTeamLabel): string | null {
  switch (team.state) {
    case 'named':
    case 'inherited':
      return team.name;
    case 'unresolved':
      return UNKNOWN_TEAM;
    case 'none':
      return null;
  }
}

/**
 * The title of the band one work item's bars sit in: the row, its pool, and how
 * important the work is.
 *
 * Three facts in a title because Mermaid has one grouping channel and no others
 * at all — no priority, no team, no lane. The number leads because the number
 * is the outline: this diagram is flat, exactly as the exported table is, and
 * `010.1` is what says where a row hangs.
 */
function sectionTitleOf(bar: GanttBar): string {
  const team = teamNameOf(bar.team);
  return [
    namedRow({ number: bar.workItemNumber, name: bar.workItemName }),
    ...(team === null ? [] : [team]),
    ...(bar.priority === null ? [] : [`P${String(bar.priority)}`]),
  ]
    .map(mermaidPhrase)
    .join(DOT);
}

/** Why a bar is drawn as a point rather than as a span. */
type MilestoneReason = 'unestimated' | 'zero';

/** What each reason is called on the task it names. */
const MILESTONE_WORDS: Record<MilestoneReason, string> = {
  unestimated: 'not estimated',
  zero: '0 days',
};

/**
 * What one bar is called: its role, whose it is, and the two facts about it that
 * have no channel of their own.
 *
 * `N at once` is on the name because a compressed bar is drawn across
 * `effort / width` days, and a reader with no key would read that span as the
 * work. The milestone words are on it because the shape a milestone draws says
 * "a point in time", which is true and is not the same fact as "nobody has said
 * how long this is".
 */
function taskNameOf(bar: GanttBar, milestone: MilestoneReason | null): string {
  return [
    bar.roleName ?? NO_ROLE,
    bar.personName ?? NOBODY,
    ...(bar.width === 1 ? [] : [`${String(bar.width)} at once`]),
    ...(milestone === null ? [] : [MILESTONE_WORDS[milestone]]),
  ]
    .map(mermaidPhrase)
    .join(DOT);
}

/** One bar resolved onto the calendar: the two dates Mermaid draws it between, and its identity. */
interface MermaidTask {
  bar: GanttBar;
  id: string;
  from: IsoDate;
  /** Where the bar stops. Equal to `from` on a milestone, which is what makes it one. */
  to: IsoDate;
  milestone: MilestoneReason | null;
}

/**
 * Every bar of the chart as a dated task, in the order the chart draws them.
 *
 * The dates come off {@link placeOnCalendar} — the chart's own placement, which
 * is what puts a weekend between a Friday finish and the Monday after it — and
 * are then **rounded outward**: a start floors, a finish ceils. A slice runs
 * `effort / width` workdays and can be a fraction; Mermaid's day is atomic, and
 * a finish rounded down would draw a bar shorter than the work in it.
 *
 * A bar with no span is drawn as a milestone rather than as a rectangle of no
 * width, and the two reasons a bar can have none are kept apart: nobody has
 * estimated the slice, or somebody estimated it at zero. **Never** the chart's
 * two-workday drawing assumption for an unestimated slice — the chart draws
 * that guess dashed and with a `?` beside it, Mermaid has neither, and two
 * solid days here would be an estimate this tool invented inside somebody
 * else's document.
 */
function tasksOf(placed: PlacedGantt, origin: IsoDate): MermaidTask[] {
  return placed.bars.map((each: PlacedBar, index): MermaidTask => {
    const from = addCalendarDays(origin, Math.floor(each.x));
    const to = each.bar.estimated ? addCalendarDays(origin, Math.ceil(each.x + each.width)) : from;
    const milestone: MilestoneReason | null = each.bar.estimated
      ? to === from
        ? 'zero'
        : null
      : 'unestimated';
    // `t1` upward in the order the bars are laid out, which is row order and
    // then role order. An id taken from the slice's own would carry be-01's
    // keys into a document a person reads; one taken from the name would
    // collide the moment two rows share a role.
    return { bar: each.bar, id: `t${String(index + 1)}`, from, to, milestone };
  });
}

/** One task line, in Mermaid's gantt grammar: `name :tags, id, from, to`. */
function taskLine(task: MermaidTask): string {
  const tags = [
    ...(task.bar.critical ? ['crit'] : []),
    ...(task.milestone === null ? [] : ['milestone']),
  ];
  const span = task.milestone === null ? `${task.from}, ${task.to}` : `${task.from}, 0d`;
  return `    ${taskNameOf(task.bar, task.milestone)} :${[...tags, task.id, span].join(', ')}`;
}

/**
 * The diagram itself: a `gantt` header, then a section per work item and a task
 * per slice.
 *
 * `excludes weekends` is what makes the picture agree with the plan — every
 * date here is a working day or the morning after one, and a renderer keeping
 * the weekend columns would draw gaps the schedule does not have.
 *
 * Sections are the chart's rows and tasks are its bars, which is the only
 * mapping that leaves the two readable as one picture: Mermaid has a single
 * grouping channel, and spending it on assignees — the chart's *colour*
 * channel — would scatter one work item's roles down the diagram. Parents
 * contribute no task, because the chart has drawn no mark on a parent row since
 * `gantt-declutter`; their numbers survive inside their leaves' own.
 */
function diagramLines(
  tasks: readonly MermaidTask[],
  doc: MermaidPlan,
  synthetic: boolean,
): string[] {
  const lines = [
    // The keyword first, before the comment block, and that is not a style
    // choice: Mermaid's public `parse` strips comments before it decides which
    // diagram it is holding, but the gantt grammar underneath it does not, and
    // a `%%` line standing where `gantt` should be is `Expecting 'gantt', got
    // 'NL'`. Measured both ways against 11.16.1 — see verify.md.
    'gantt',
    ...commentLines(doc, synthetic),
    `    title ${mermaidPhrase(doc.projectName)}`,
    '    dateFormat YYYY-MM-DD',
    '    axisFormat %d %b',
    '    excludes weekends',
  ];
  let section: string | null = null;
  for (const task of tasks) {
    const title = sectionTitleOf(task.bar);
    if (title !== section) {
      section = title;
      lines.push('', `    section ${title}`);
    }
    lines.push(taskLine(task));
  }
  return lines;
}

/**
 * Every stored dependency of the plan, in words.
 *
 * Mermaid's gantt draws no dependency arrows at all. Its `after` keyword
 * *positions* a task, which would replace be-01's dates with Mermaid's own
 * arithmetic — which is why every task above carries two explicit dates
 * instead — and it still draws no line. So the edges leave as a list, read off
 * {@link GanttGeometry.arrows}, the same collection the chart draws its arrows
 * from, so the two cannot come to different answers about which edges exist.
 */
function dependencyLines(chart: GanttGeometry): string[] {
  const named = new Map(chart.labels.map((label) => [label.id, namedRow(label)]));
  return chart.arrows.flatMap((arrow) => {
    const successor = named.get(arrow.successorId);
    const predecessor = named.get(arrow.predecessorId);
    // Unreachable rather than guarded, and written as a skip for that reason:
    // `layOutGantt` builds `labels` and `arrows` from the same `rows` list and
    // drops an edge whose ends it holds no row for, so there is no name to be
    // missing here. A throw whose failure can never be watched is a claim
    // rather than a gate — AGENTS.md R5, seventeen times over.
    return successor === undefined || predecessor === undefined
      ? []
      : [`${successor} waits for ${predecessor}`];
  });
}

/**
 * Every slice a resource held up, with the chart's own sentence for why.
 *
 * The two floors the chart draws a **line** for: a team with no slot free
 * (`capacity`) and a named person who was busy (`person`). Mermaid draws
 * neither, and these are the two a reader cannot recover from the picture —
 * every other floor is either the shape itself (a predecessor, an earlier role
 * on the same row) or a date listed below.
 *
 * The waiting slices are found through the chart's own link collections rather
 * than through a second reading of `boundBy`, which {@link GanttBar} does not
 * carry: a link exists exactly where the chart drew one. The sentence is
 * {@link GanttBar.floorWords} verbatim — the words the bar shows on hover — so
 * the document and the chart say the same thing about the same slice.
 */
function waitLines(chart: GanttGeometry): string[] {
  const waiting = new Set([
    ...chart.capacityLinks.map((link) => link.toSliceId),
    ...chart.personLinks.map((link) => link.toSliceId),
  ]);
  return chart.bars
    .filter((bar) => waiting.has(bar.sliceId))
    .map(
      (bar) =>
        `${namedRow({ number: bar.workItemNumber, name: bar.workItemName })}${DOT}` +
        `${bar.roleName ?? NO_ROLE} — ${bar.floorWords}`,
    );
}

/**
 * Every row held by a start-no-earlier-than date, and the date.
 *
 * The chart draws a caret at the offset; Mermaid has no mark for "this cannot
 * begin before here" and needs one, because a row held by a date and a row held
 * by its predecessor are drawn identically here and are two different facts to
 * act on.
 *
 * The date comes off the **placed** flag and never off the geometry's own
 * `offset`, which is a workday number: workday 8 of a plan starting on Monday
 * 1 June is Thursday the 11th, and the raw offset read as a calendar day is
 * Tuesday the 9th. Every mark on this document goes through one scale.
 *
 * Walked over the labels rather than over the flags, so the list comes out in
 * the plan's own row order and so a row index never has to be looked up in an
 * array that might be shorter than it — `layOutGantt` builds both collections
 * in one pass over the same rows, and a guard for a mismatch it cannot produce
 * is a check nothing could ever watch fail.
 */
function notBeforeLines(placed: PlacedGantt, origin: IsoDate): string[] {
  return placed.labels.flatMap((label) => {
    const flag = placed.notBeforeFlags.find((each) => each.rowIndex === label.rowIndex);
    return flag === undefined
      ? []
      : [`${namedRow(label)} — not before ${addCalendarDays(origin, Math.floor(flag.x))}`];
  });
}

/** One bullet of the legend: what it is about, the lines under it, and what stands in for none. */
interface Loss {
  headline: string;
  /** What the bullet says when the plan holds none of this — never silence. */
  none: string;
  lines: string[];
}

/**
 * The whole of what the diagram does not draw, as Markdown under the fence.
 *
 * Under it and not only inside it, and that is the point of this function: a
 * `%%` comment is invisible in a rendered diagram, and the failure this export
 * is written against is a picture that **looks** complete. The comment block is
 * for whoever reads the source; this is for whoever reads the picture.
 *
 * Every bullet is printed even when its list is empty, with words saying the
 * plan holds none of that fact. A bullet that vanished with its list would
 * leave a reader unable to tell "this plan has no dependencies" from "this
 * document dropped them".
 */
function legendLines(chart: GanttGeometry, placed: PlacedGantt, origin: IsoDate): string[] {
  const losses: Loss[] = [
    {
      headline:
        "**Dependency arrows.** Mermaid's gantt draws none, so every stored dependency is listed here:",
      none: "**Dependency arrows.** Mermaid's gantt draws none. This plan stores none either.",
      lines: dependencyLines(chart),
    },
    {
      headline:
        '**Why a bar starts where it does.** The chart draws a line to whatever held a slice up; here it is words:',
      none: "**Why a bar starts where it does.** Nothing in this plan was held up by a team's capacity or by a busy assignee.",
      lines: waitLines(chart),
    },
    {
      headline:
        '**Start-no-earlier-than dates.** The chart draws a caret at each one; Mermaid has no mark for one:',
      none: '**Start-no-earlier-than dates.** No row in this plan carries one.',
      lines: notBeforeLines(placed, origin),
    },
  ];
  return [
    '**What this diagram does not draw** — the plan holds all of it, and **Copy as Markdown** puts every field of every row in a table.',
    '',
    ...losses.flatMap((loss) =>
      loss.lines.length === 0
        ? [`- ${loss.none}`]
        : [`- ${loss.headline}`, ...loss.lines.map((line) => `  - ${line}`)],
    ),
    '- **Nothing at all draws:** slack on a row that is not on the critical path, one colour per assignee, how many people a work item asked for against how many its pool gave it, the parent rows’ spans, the three points behind each figure, and the chart’s Detail switch — a control, not a document.',
  ];
}

/**
 * The comment block inside the fence: what this is, when it was taken, and the
 * two things a reader has to know before believing a date on it.
 *
 * Mermaid keeps `%%` lines out of the picture, which is exactly why the same
 * losses are written twice — see {@link legendLines}.
 */
function commentLines(doc: MermaidPlan, synthetic: boolean): string[] {
  return [
    `    %% ${mermaidComment(doc.projectName)} — exported from the WBS tool at ${doc.generatedAt}.`,
    "    %% Mermaid's gantt is a weaker drawing than the chart this came from: no dependency",
    '    %% arrows, no capacity or hand-off lines, no assignee colours, no slack. What it',
    '    %% cannot draw is written out under the diagram — do not read this picture as the',
    '    %% whole plan.',
    '    %% Bars are drawn in whole days: a start rounds down and a finish rounds up, so no',
    '    %% bar is drawn shorter than the work in it.',
    ...(synthetic
      ? [
          `    %% This plan is not on a calendar. Day zero is drawn as ${SYNTHETIC_ORIGIN}, a Monday,`,
          '    %% so every date below is an offset from it, not a day anybody has agreed to.',
        ]
      : []),
  ];
}

/** What a document with no diagram says instead, and why there is none. */
const NO_DIAGRAM: Record<'cycle' | 'unscheduled', string> = {
  cycle:
    'These dependencies run in a circle, so no schedule could be worked out and there is no diagram to draw. Every bar would stand on day zero, which reads as "everything happens at once".',
  unscheduled: 'This plan has no scheduled work in it yet, so there is no diagram to draw.',
};

/**
 * A plan as a Markdown document with a Mermaid `gantt` in it: a fenced diagram,
 * a comment block inside the fence, and a legend under it naming everything the
 * diagram cannot hold.
 *
 * **Deterministic.** No clock, no randomness, and nothing iterated in the order
 * of a map keyed by object identity: the same plan and the same `generatedAt`
 * produce the same bytes, which is what makes the output diffable in whatever
 * document it is pasted into.
 *
 * The whole trip is owned here rather than split with the caller because the
 * two states with no diagram — a cycle, and a plan nothing has scheduled yet —
 * have to be decided **before** {@link layOutGantt} is asked for a layout: with
 * no slices in the payload a dependency has no anchor to leave from, and the
 * layout throws. A caller that had to know that is a caller that can forget it.
 *
 * @throws GanttDataError out of `layOutGantt` when the payload's slices
 * name a role, a person or a slice the plan does not hold. The caller reports
 * it: a document written from a payload that lost something is a document with
 * a hole nothing marks.
 * @throws Whatever `addWorkdays` throws when `startDate` is not a calendar date.
 */
export function planToMermaid(plan: GanttPlan, doc: MermaidPlan): string {
  if (doc.scheduleError !== null) return `${NO_DIAGRAM.cycle}\n`;
  if (plan.slices.length === 0) return `${NO_DIAGRAM.unscheduled}\n`;
  const chart = layOutGantt(plan);
  // `addWorkdays(_, 0)` and not the date itself: a project whose start date
  // lands on a weekend begins on the Monday, and `placeOnCalendar` measures its
  // offsets from that same normalised day. Two origins would stand every date
  // on this diagram a day or two off the ones the table prints.
  const origin = addWorkdays(doc.startDate ?? SYNTHETIC_ORIGIN, 0);
  // One placement, read by the diagram and by the legend alike: two calls would
  // be two chances for a mark and the sentence about it to land on different
  // days.
  const placed = placeOnCalendar(chart, origin);
  const tasks = tasksOf(placed, origin);
  return [
    `${FENCE}mermaid`,
    ...diagramLines(tasks, doc, doc.startDate === null),
    FENCE,
    '',
    ...legendLines(chart, placed, origin),
    '',
  ].join('\n');
}
