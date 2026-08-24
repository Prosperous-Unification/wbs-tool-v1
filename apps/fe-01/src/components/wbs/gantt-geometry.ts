import {
  addWorkdays,
  calendarDaysBetween,
  firstWorkdayOf,
  type IsoDate,
  lastWorkdayOf,
  snapWorkdays,
} from '@wbs/domain/workday';

import type { PriorityBandView } from '@/lib/wbs-api';

import { shortIsoDate } from './short-date';

/**
 * The payload promised something the drawing needs and did not keep it.
 *
 * Malformed trusted data, which is an invariant failure and not a state to
 * render: a `resourcePredecessorId` naming no slice in the same payload, a
 * person floor with nobody to name, a slice under a role the plan does not
 * list. be-01 computes all four facts in one pass from one graph, so a
 * mismatch means the wire lost something between them — drawing a chart with
 * a silently missing link would hide exactly the fact the panel exists to
 * show. The panel lets this reach the error boundary.
 *
 * Not thrown for a mark whose row is off screen: a collapsed branch or a
 * search is a modeled absence, and the mark is skipped. See
 * {@link layOutGantt}.
 */
export class GanttDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GanttDataError';
  }
}

/**
 * The one thing a slice's start is set by, named — the wire's `boundBy`.
 *
 * Structurally the same union as be-01's `ScheduleFloor` and deliberately
 * declared again here: this module knows nothing about fetching, and the
 * geometry's tests build slices by hand.
 *
 * `capacity` is the sixth and arrived with `capacity-engine`: the slice's
 * **team** had no slot free, which is a different fact from a named person
 * being busy (`person`) and is said in different words. be-01 has been sending
 * it since that change merged; until this one it reached the `default:` below
 * and threw the panel into its error boundary — the deploy gate
 * `capacity-write-paths` recorded.
 */
export type BindingFloor =
  | 'projectStart'
  | 'predecessor'
  | 'roleOrder'
  | 'notBefore'
  | 'person'
  | 'capacity';

/**
 * The ten colours a person's bars are drawn in, handed out in this order.
 *
 * Matplotlib's `tab10`, taken whole rather than sampled from the app's own
 * tokens: the app's palette is one hue in five lightnesses — built to keep
 * chrome quiet — and ten people need ten hues a reader can tell apart at 28px
 * wide. These are the qualitative set that has been squinted at longest.
 *
 * An eleventh person wraps onto the first colour. Two people sharing a colour
 * is a legible chart with an ambiguity in it; a generated eleventh hue next to
 * these ten is an illegible one.
 */
export const PERSON_BAR_COLORS = [
  '#1f77b4',
  '#ff7f0e',
  '#2ca02c',
  '#d62728',
  '#9467bd',
  '#8c564b',
  '#e377c2',
  '#7f7f7f',
  '#bcbd22',
  '#17becf',
] as const;

/**
 * The colour of a slice nobody is on.
 *
 * Deliberately outside {@link PERSON_BAR_COLORS} and deliberately grey: an
 * unassigned slice is the absence of a person, and it must not read as an
 * eleventh one.
 */
export const UNASSIGNED_BAR_COLOR = '#94a3b8';

/**
 * The colour every pool wait is drawn in — see {@link GanttCapacityLink}.
 *
 * **One colour for every team, deliberately.** The plan's words were "tinted
 * from the team rather than the person", and the reading taken here is the
 * literal one: not the assignee's colour. A palette *per team* was the other
 * reading and is refused — it would hand teams the same ten hues people are
 * drawn in, so a chart with kat's bars and Platform's waits on it would have
 * two different facts in one colour, and the reader has no key to tell them
 * apart. Which team is short of people is on the bar in words and in its hover
 * sentence, where a name belongs.
 *
 * Outside {@link PERSON_BAR_COLORS} and outside {@link UNASSIGNED_BAR_COLOR}
 * for that same reason.
 */
export const CAPACITY_LINK_COLOR = '#b45309';

/**
 * A colour a bar can be painted: one of the ten, or the unassigned grey.
 *
 * A union rather than `string`, and that is what lets {@link inkOn} parse a
 * hex without asking what happens when it is not one. Validate at the boundary,
 * keep the internal type precise.
 */
export type BarColor = (typeof PERSON_BAR_COLORS)[number] | typeof UNASSIGNED_BAR_COLOR;

/** The two colours a bar's own label is ever written in. */
const BAR_LABEL_LIGHT = '#ffffff';
const BAR_LABEL_DARK = '#0f172a';

/**
 * How light a bar has to be before its label is written in dark ink.
 *
 * 0.35 of WCAG relative luminance, chosen against the palette rather than out
 * of the standard: it puts `#bcbd22`, `#17becf` and `#ff7f0e` — the three
 * `tab10` entries white is nearly invisible on — over the line, and leaves the
 * other seven under it.
 */
const BAR_LABEL_DARK_ABOVE = 0.35;

/**
 * The ink a bar's label is written in, so it can be read on that bar.
 *
 * WCAG relative luminance of the fill, and the darker of two inks above
 * {@link BAR_LABEL_DARK_ABOVE}. One white for all ten colours is what a
 * qualitative palette cannot have: `#bcbd22` is a highlighter, and white on it
 * is a label nobody reads.
 *
 * No malformed-input branch, and that is the type's doing rather than an
 * omission: {@link BarColor} is eleven six-digit hexes, so the parse below
 * cannot come back `NaN`.
 */
export function inkOn(barColor: BarColor): string {
  const linear = [1, 3, 5]
    .map((at) => Number.parseInt(barColor.slice(at, at + 2), 16) / 255)
    .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  const luminance = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  // Proof: the threshold raised to 99, which no luminance reaches — one white
  // for every bar, which is what this function exists not to do. `writes the
  // label in ink the bar can be read through` alone failed, on `expected
  // '#ffffff' to be '#0f172a'`; watched 2026-08-09.
  return luminance > BAR_LABEL_DARK_ABOVE ? BAR_LABEL_DARK : BAR_LABEL_LIGHT;
}

/**
 * The service team a work item is labelled with, as the chart can state it.
 *
 * Four states and not a `string | null`, because "nobody labelled this" and
 * "the team read this client holds does not name that id" are different facts
 * and a blank says neither. The second is a **modeled** condition rather than a
 * broken payload: the teams come from the directory read and the label from the
 * tree read, two moments, and a team created between them is a stale lookup and
 * not a lost one.
 *
 * `inherited` is the fourth and is what makes the scheduler's rule readable:
 * a leaf with no label of its own is scheduled on the **nearest ancestor's**
 * team (`effectiveTeamOf` in `libs/domain`), so a bar can be held by a pool the
 * row it sits on never named. It carries the ancestor it came from because
 * every surface that shows an inherited label has to be able to say where it
 * came from — "Platform — inherited from 010 Backend" is the sentence, and a
 * boolean cannot say it.
 */
export type ServiceTeamLabel =
  | { state: 'none' }
  | { state: 'named'; name: string }
  | { state: 'inherited'; name: string; fromRow: string }
  | { state: 'unresolved' };

/**
 * What kind of thing a row is, as any face can state it — {@link
 * ServiceTeamLabel}'s shape for the other dimension, with two differences that
 * are both the model rather than the surface.
 *
 * **`names` is a list**, because a work item carries as many tags as somebody
 * put on it. The team's is a single `name` because the write path still sends
 * one team; there is no such stage here and never was.
 *
 * **There is no `unresolved` arm.** A team can go missing between the tree read
 * and the directory read, and the chart has to say so rather than draw a blank
 * pool. A tag that the directory has not caught up with narrows nothing and
 * decides nothing — no date depends on it — so a face that simply does not
 * name it is telling the truth, and a fourth state would be a word on screen
 * about a race nobody can act on.
 */
export type TagLabel =
  | { state: 'none' }
  | { state: 'named'; names: readonly string[] }
  | { state: 'inherited'; names: readonly string[]; fromRow: string };

/**
 * What a row is **delivered by**, as any face can state it.
 *
 * Structurally {@link TagLabel} since task 10.4, and it was structurally
 * {@link ServiceTeamLabel} before it. D2 put one service on a work item as a
 * nullable column; the 2026-08-21 scope change ("can be several services") made
 * the store a join table, so `names` is a list here for exactly the reason it is
 * one on the tag: a work item carries as many services as somebody put on it.
 *
 * **The `unresolved` arm went with the widening, and that is a decision rather
 * than a translation.** It existed because a single-valued label the directory
 * could not name had no way to appear at all — the box simply drew empty, which
 * claims the row has no service when what happened is that its name could not be
 * found. A set is shown as a chip per stated id and a chip falls back to the id
 * itself, so the row can no longer go quiet: an unnamed service is on screen as
 * an id, which is ugly and honest. That is {@link TagLabel}'s own argument, and
 * this type now carries it for the same reason.
 *
 * **Still its own type rather than an alias of `TagLabel`.** The service
 * dimension is not a general label — it decides `builtByNonOwner` against the
 * team's owned set, and a tag decides nothing. Sharing a shape is not being
 * the same thing, which is the argument the old alias of `ServiceTeamLabel`
 * already made one dimension over: `service_team` is the *team* (D9 keeps that
 * table name while blue/green shares one SQLite file), and a reader who found
 * `ServiceTeamLabel` on the service cell would reasonably conclude the split had
 * not happened.
 */
export type ServiceLabel =
  | { state: 'none' }
  | { state: 'named'; names: readonly string[] }
  | { state: 'inherited'; names: readonly string[]; fromRow: string };

/** The three points a role was estimated with, as the plan holds them. */
export interface EstimateTrio {
  optimistic: number;
  realistic: number;
  pessimistic: number;
}

/**
 * A row of the plan as the panel draws it.
 *
 * The shown rows only — the panel passes the same list its renderer draws, so
 * mirroring the tree is identity rather than synchronisation. `schedule` is
 * the work item's projection and carries no more of it than the layout
 * reads: a dependency arrow lands on a row's start — the arrow *leaves* the
 * predecessor's anchor slice, selected from `slices`, never this
 * projection's finish — and a parent's projection is spanned as a bracket
 * the panel has drawn no mark from since `gantt-declutter` — see
 * {@link PlacedBracket}.
 */
export interface GanttRow {
  id: string;
  /**
   * The derived number the plan's Number column shows for this row — `010`,
   * `010.2`. Carried rather than derived here: the table already computes it,
   * and a second derivation is two numbering rules to keep in step.
   */
  number: string;
  name: string;
  /** How deep in the tree, 0 at the root. The label's indent. */
  depth: number;
  /** True when this row's own slices are laid out as bars; false when it is spanned by a bracket. */
  leaf: boolean;
  schedule: { earliestStart: number; earliestFinish: number };
  /** The workday its manual start date holds at, or null when it has none. */
  notBeforeOffset: number | null;
  /**
   * Why that date is there, in the planner's own words, or null where nobody
   * has said.
   *
   * Read on one line of one surface: the floor sentence of a bar whose
   * **binding** floor is the not-before. Not on a bar held by something else,
   * because the sentence there is about the something else and this row's date
   * is not what is holding it; not on the flag, which says the date; and not as
   * a state anywhere, because it is not one — see `notes/decisions.md`,
   * 2026-08-18, for what it was built instead of.
   *
   * **Optional, and nothing on screen fills it yet.** The `ganttPlan` literal in
   * `wbs-table.tsx` builds these rows and was another agent's file to edit while
   * this was written — the one line it owes is
   * `notBeforeReason: row.original.startNoEarlierThanReason`, beside the
   * `notBeforeOffset` it already computes from the same field. Until that lands
   * be-01 stores and serves the words, this module prints them for any row that
   * carries one, and the chart on screen draws exactly what it drew before:
   * a feature that is invisible rather than one that is wrong. Optional and not
   * required so that the missing line is a feature nobody can see rather than a
   * build nobody can run.
   */
  notBeforeReason?: string | null;
  /**
   * How important this work is — 1 upward, smaller first — or null where
   * nobody has said.
   *
   * Carried so a bar can say it, and for nothing else: it is be-01's engine
   * that priorities the queue, and the coordinates on this chart are already the
   * answer. Nothing here reads it as a position.
   */
  priority: number | null;
  /**
   * How many people this work item may have on it at once, as somebody typed
   * it — 1 on every row nobody has told otherwise.
   *
   * The **stored** number, never the scheduled one: a named person collapses
   * the width to 1 (D3) and a team's size clamps it, and the slice's own
   * {@link GanttSlice.width} is what came out of both. The bar carries the two
   * so it can say when they differ, which is the only way a reader learns that
   * the number they typed did nothing.
   */
  maxParallel: number;
  /** The service team this work is labelled with, resolved against the directory read. */
  team: ServiceTeamLabel;
  /**
   * What kind of thing this work is, resolved against the directory read — the
   * **effective** set, so an inherited tag reaches the chart the same way an
   * inherited team does.
   *
   * Carried so a bar can say it, and for nothing else. The team beside it is
   * read by {@link floorWordsOf} because a pool decides dates; **no coordinate
   * on this chart reads this field**, and nothing here may start to — a tag
   * narrows a view and names a kind, and neither of those is a day. The
   * assertion is a test rather than a comment: `layOutGantt` over the same plan
   * tagged and untagged places every bar, bracket, arrow and link at the same
   * numbers.
   */
  tags: TagLabel;
  /**
   * The three points each role was estimated with on this work item, by role id.
   *
   * A role absent from this map is a role nobody has estimated here, which is
   * the fact the bar states in words. Per row and per role rather than per
   * slice, because that is the shape be-01 sends it in and a bar's role is what
   * picks one out.
   */
  trioByRole: ReadonlyMap<string, EstimateTrio>;
  /**
   * What this row waits for, each already named `<number> <name>`.
   *
   * Resolved by the caller from **every** work item in the tree, not from the
   * rows the chart is drawing: a collapsed branch and a search each hide rows a
   * dependency may point at, and a predecessor hidden that way is still named
   * in full. That is why these are words rather than ids — the geometry sees
   * only what is on screen.
   */
  waitsFor: readonly string[];
}

/**
 * One scheduled slice as it arrives on the wire.
 *
 * `id` and `resourcePredecessorId` are the engine's own keys and are opaque:
 * looked up, never taken apart. `duration` rides alongside
 * `earliestStart`/`earliestFinish` because a bar is drawn from a start and a
 * width, and recomputing the width as a subtraction is how a rounding creeps
 * into numbers the panel promises to draw verbatim.
 */
export interface GanttSlice {
  id: string;
  workItemId: string;
  roleId: string | null;
  personId: string | null;
  duration: number;
  estimated: boolean;
  earliestStart: number;
  earliestFinish: number;
  /** How many workdays this slice can slip before the project's finish moves. */
  float: number;
  critical: boolean;
  boundBy: BindingFloor;
  /**
   * The slice this one waited for, or null when it waited for nobody.
   *
   * Two floors put a slice here and the id means the same thing in both: the
   * **display referent**, one placed slice this one had to wait on. Under
   * `person` it is what the assignee was finishing; under `capacity` it is one
   * of {@link GanttSlice.capacityPredecessorIds} — be-01 picks the latest
   * finisher of the blocking set, and the whole set is carried beside it
   * because "and 2 others" is a fact a single id cannot state.
   */
  resourcePredecessorId: string | null;
  /**
   * How many of the team's slots this slice holds while it runs — 1 unless the
   * plan says otherwise.
   *
   * The **effective** width be-01 scheduled with, already clamped to the
   * team's size and already collapsed to 1 where a person is named: the number
   * the dates were computed from, not the number somebody typed. What was
   * typed is the work item's `maxParallel`, and the two differing is exactly
   * what the bar's facts explain.
   */
  width: number;
  /**
   * How many days of work this slice is, before it was compressed across
   * {@link GanttSlice.width} slots.
   *
   * `duration` is what the bar is drawn across — `effort / width` — and this is
   * what was estimated. Carried rather than multiplied back out of the two:
   * the engine divided in doubles and a chart that multiplied would print a
   * number the plan does not hold.
   */
  effort: number;
  /**
   * Every placed slice that had to end for this one to fit its pool.
   *
   * Empty for every floor but `capacity`, and **never** empty under it: a
   * slice held by a pool that nothing was holding is a payload that has lost
   * the reason for its own date, and {@link layOutGantt} refuses it rather
   * than drawing a sentence with a hole in it.
   */
  capacityPredecessorIds: readonly string[];
}

/** A stored dependency between two work items, either end of which may be a parent. */
export interface DependencyEdge {
  predecessorId: string;
  successorId: string;
}

/** One work item of the full tree: its id and its parent, nothing a hidden row would need. */
export interface GanttTreeRow {
  id: string;
  parentId: string | null;
}

/** A role of the plan: its id, its name for the words on a bar, and its place in the list. */
export interface GanttRole {
  id: string;
  name: string;
}

/**
 * Everything the panel knows, in the units the engine computed it in.
 *
 * `roles` is a list rather than a lookup because its **order** is load-bearing
 * — a leaf's bars sit in role order, which is the order the plan lists its
 * roles in. `personNames` is a lookup because nothing about the drawing
 * depends on the order people are in.
 */
export interface GanttPlan {
  rows: readonly GanttRow[];
  slices: readonly GanttSlice[];
  /**
   * **Every** stored dependency the plan holds, not only the shown rows' own.
   *
   * An edge with either end off screen is dropped by {@link layOutGantt} and
   * counted into {@link GanttGeometry.droppedLinks}, so what is drawn is
   * unchanged by the widening: an edge is drawn when both its ends are on the
   * chart, which is exactly the set the shown rows' own edges used to give.
   * What the widening buys is the *other* direction — a bar on screen whose
   * **successor** is hidden used to lose its arrow without the loop ever seeing
   * the edge, and so without anything to count (F3).
   */
  dependencies: readonly DependencyEdge[];
  /**
   * Every work item of the plan with its parent — the full tree the shown
   * rows were cut from, in tree order.
   *
   * What a dependency arrow's anchor is selected through: a predecessor that
   * is a collapsed branch keeps its leaves here after `rows` has dropped
   * them, and the arrow must still leave the latest-finishing anchor among
   * them (design.md D6). Ids and parents alone, because ancestry is the one
   * fact about a hidden row the drawing needs.
   */
  tree: readonly GanttTreeRow[];
  /**
   * Whether a filter is why {@link GanttPlan.rows} is the length it is.
   *
   * A list of rows cannot say why it is short, and the panel must not guess:
   * the same three rows arrive under a filter somebody has been sitting in for
   * an hour and under a branch they collapsed with their own hand a moment ago.
   * The one thing this decides is whether the panel says what it could not draw
   * ({@link GanttGeometry.droppedLinks}) — under a persistent filter a silently
   * missing arrow is a schedule diagram that looks complete and is not
   * (`notes/wbs-brief-2026-08-17-r10-filtering.md` §8.2); a collapse is the
   * momentary act this repo has always treated it as, and the triangle that
   * caused it is on the row.
   *
   * On the plan and not a prop of the panel for {@link GanttPlan.priorityBands}'
   * reason: it arrives with the rows it is a fact about, so the list drawn and
   * the account of why it is that list cannot be answers to two moments. Like
   * the bands, `layOutGantt` does not read it — no geometry depends on it.
   */
  narrowedByFilter: boolean;
  roles: readonly GanttRole[];
  personNames: ReadonlyMap<string, string>;
  /**
   * What this plan calls its priority numbers — five rungs, most important first.
   *
   * On the chart read rather than on the panel's props for the reason `roles` and
   * `personNames` are: it arrives in the same payload as the slices, so the label
   * a bar is drawn with and the number it was drawn from cannot be answers to two
   * different moments.
   *
   * `layOutGantt` does not read it, and that is deliberate: **no geometry depends
   * on a priority.** The band decides a colour and a sentence, both resolved at
   * paint time through `priorityBandStyleOf`, which is the one place a band
   * becomes a style anywhere in this app.
   */
  priorityBands: readonly PriorityBandView[];
}

/** A row's label: what the sticky-left column prints, and which row of the chart it belongs to. */
export interface GanttRowLabel {
  id: string;
  /** The row's derived number, printed before its name — see {@link GanttRow.number}. */
  number: string;
  name: string;
  depth: number;
  rowIndex: number;
}

/**
 * How many workdays an unestimated slice's bar is **drawn** across.
 *
 * A drawing assumption and not a schedule fact. Nobody has said how long this
 * slice is, so the engine gives it zero days — and a bar of zero days is a mark
 * with no area, which reads as "there is nothing here" when the truth is "we do
 * not know yet". Two workdays is the smallest span that reads as a task at the
 * panel's 28px workday and is short enough that nobody mistakes it for an
 * estimate.
 *
 * **It changes nothing but the drawing.** The engine's numbers are untouched —
 * the slice still starts and finishes where be-01 placed it, the table's Start
 * and End columns are unmoved, `data-start`/`data-finish` still carry the
 * engine's numbers verbatim, and dependency arrows and person links are still
 * drawn between them. Only {@link GanttBar.drawnSpan} and the horizon that has
 * to contain it know about this number.
 *
 * Whether an unestimated bar is painted at all is the detail switch's answer
 * (`declutter-one-button`): the panel narrows this list to the estimated slices
 * at rest and takes it whole once the switch is pressed (`drawnBars`), and the
 * dashed translucent outline and the `?` that say the span is a guess come with
 * the mark. The horizon reserves this width in **both** states, which is what
 * makes the switch a decision about paint and not about layout.
 */
export const ASSUMED_UNESTIMATED_WORKDAYS = 2;

/**
 * One slice drawn: where it starts and how wide it is on the workday axis,
 * which row it is on, and why it starts there.
 *
 * `start`, `finish`, `duration` and `drawnSpan` are workdays and `rowIndex` is
 * a row — never pixels. The panel's SVG user space is those two units, so these
 * numbers reach `x`, `width` and `y` unconverted.
 */
export interface GanttBar {
  sliceId: string;
  rowIndex: number;
  start: number;
  finish: number;
  duration: number;
  /**
   * How wide the bar is **drawn**, in workdays: `duration` for an estimated
   * slice, and {@link ASSUMED_UNESTIMATED_WORKDAYS} for one nobody has
   * estimated.
   *
   * The one number on this bar that is not the engine's, and the only one the
   * width is ever taken from. `duration` stays what be-01 computed, which is
   * what `data-finish` and the hover text are written from — see
   * {@link ASSUMED_UNESTIMATED_WORKDAYS} for why the two are allowed to differ
   * and what says so on screen.
   */
  drawnSpan: number;
  /** How many workdays this bar can slip before the project's finish moves. */
  float: number;
  critical: boolean;
  /** False when nobody has estimated this slice, which is not the same fact as zero days. */
  estimated: boolean;
  /** The work item this slice is work for — the number on the row the bar sits on. */
  workItemNumber: string;
  /** The work item this slice is work for — the name on the row the bar sits on. */
  workItemName: string;
  /** The role this slice is work for, or null when it belongs to no role. */
  roleName: string | null;
  /** Whose slice this is, or null when nobody is on it. */
  personName: string | null;
  /**
   * The colour the bar is painted, which is **who** is on it.
   *
   * One of {@link PERSON_BAR_COLORS}, or {@link UNASSIGNED_BAR_COLOR} when
   * nobody is. Decided here rather than in the component because the mapping is
   * a fact about the whole chart — the same person is the same colour on every
   * row — and a component that decided it per bar could not be asked whether
   * they are.
   */
  personColor: BarColor;
  /** The binding floor in words — the sentence the bar shows on hover. */
  floorWords: string;
  /** The service team the work item is labelled with — see {@link GanttRow.team}. */
  team: ServiceTeamLabel;
  /**
   * The tags the work item is labelled with — see {@link GanttRow.tags}.
   *
   * On the bar and not on the row alone because the hover surface is built per
   * bar, and a second lookup from bar to row is a second place for the two to
   * disagree. Read by words only.
   */
  tags: TagLabel;
  /** How many of its team's slots this bar holds — see {@link GanttSlice.width}. */
  width: number;
  /** What the work item asks for, before the pool and the person had their say — see {@link GanttRow.maxParallel}. */
  maxParallel: number;
  /** The days of work this bar's `duration` is `effort / width` of — see {@link GanttSlice.effort}. */
  effort: number;
  /**
   * The three points **this bar's own role** was estimated with, or null when
   * that role has no estimate on this work item.
   *
   * The bar's role and not the row's: a leaf estimated Dev `2/3/8` and QA
   * `1/1/1` draws two bars, and a trio taken from the row would put the same
   * three numbers on both.
   */
  trio: EstimateTrio | null;
  /** What the bar's row waits for, in words — see {@link GanttRow.waitsFor}. */
  waitsFor: readonly string[];
  /** The priority on the work item this slice is work for — see {@link GanttRow.priority}. */
  priority: number | null;
}

/**
 * A parent drawn: the span of its projection, never the sum of what is under
 * it. Two independent children of 3 and 4 days are 7 days of work in a 4-day
 * branch, and this is the branch.
 */
export interface GanttSummaryBracket {
  rowId: string;
  rowIndex: number;
  start: number;
  finish: number;
}

/**
 * A stored dependency drawn: the predecessor's **anchor** to the successor's
 * start — the anchor slice's span for a leaf predecessor, and for a parent the
 * latest-finishing anchor among its leaves. Never the projection finish: the
 * predecessor's later roles run in parallel with the successor, so an arrow
 * from the projection would point backwards past the start it lands on.
 */
export interface GanttDependencyArrow {
  predecessorId: string;
  successorId: string;
  fromRowIndex: number;
  /**
   * Where the anchor begins.
   *
   * Not a coordinate the arrow is drawn at — the line leaves `fromFinish`. It
   * is carried because a **span** is what a calendar reading needs: an anchor
   * of no days at all — an unestimated first role — is on no workday, and its
   * finish then has to be read as its own start rather than as the end of the
   * workday before it. See {@link placeOnCalendar}.
   */
  fromStart: number;
  fromFinish: number;
  toRowIndex: number;
  toStart: number;
}

/**
 * One person's hand-off drawn: the slice they were busy with, to the slice
 * that waited for them. Never a dependency — the two are drawn unalike
 * because they are different facts.
 */
export interface GanttPersonLink {
  fromSliceId: string;
  fromRowIndex: number;
  /** Where the busy slice begins — carried for {@link GanttDependencyArrow.fromStart}'s reason. */
  fromStart: number;
  fromFinish: number;
  toSliceId: string;
  toRowIndex: number;
  toStart: number;
  /**
   * The colour of the person whose hand-off this is — the same colour as the
   * two bars it joins, which is what makes the line read as theirs rather than
   * as a second kind of dependency.
   */
  personColor: BarColor;
}

/**
 * One pool wait drawn: the slice whose finish freed the slots, to the slice
 * that was waiting for them.
 *
 * A third kind of line and not a person link with a different colour: a person
 * link says *this human was busy*, and this says *this team had nobody spare*.
 * The two are drawn apart because a reader who cannot tell them apart cannot
 * act on either — one is solved by hiring, the other by reassigning.
 *
 * Drawn from the **display referent** and never from the words: the sentence on
 * the bar can name "and 2 others", and a line per blocker would be a fan of
 * edges onto one start that no reader can follow.
 */
export interface GanttCapacityLink {
  fromSliceId: string;
  fromRowIndex: number;
  /** Where the freeing slice begins — carried for {@link GanttDependencyArrow.fromStart}'s reason. */
  fromStart: number;
  fromFinish: number;
  toSliceId: string;
  toRowIndex: number;
  toStart: number;
}

/** Where a row's manual start date holds, on the workday axis. */
export interface GanttNotBeforeFlag {
  rowIndex: number;
  offset: number;
}

/**
 * How many waits this chart knows about and did not draw, because one end of
 * each is a row the screen is not showing.
 *
 * The three numbers are the three kinds of line the chart has, counted at the
 * three places that already drop them — a stored dependency, a person's
 * hand-off from their own last piece of work, and a wait for a team to free
 * somebody up. Kept apart rather than summed here because they are answered
 * differently: a dropped dependency is a wait somebody typed, and the other two
 * are waits the engine worked out.
 *
 * **Counted, never redrawn.** Pulling the other end back onto the chart is what
 * R10 §9's Q7 refused — one edge can drag a whole plan back through the closure
 * — so what F3 buys is the sentence, not the arrow.
 *
 * A link with **neither** end drawn is not counted: nothing on screen lost a
 * mark, and a number counting waits between two rows the reader cannot see is a
 * number nobody can act on. See {@link droppedLinkWords}.
 */
export interface DroppedLinks {
  /** Stored `depends on` edges with one end on screen and the other off it. */
  dependencies: number;
  /** Hand-offs where one person's next piece of work waits on their last. */
  personLinks: number;
  /** Waits for a team to have somebody free. */
  capacityLinks: number;
}

/** No wait went undrawn, which is what a chart of the whole plan hands back. */
const NO_DROPPED_LINKS: DroppedLinks = { dependencies: 0, personLinks: 0, capacityLinks: 0 };

/** Every undrawn wait, whatever kind — what the sentence counts and the panel asks about. */
export function droppedLinkCount(dropped: DroppedLinks): number {
  return dropped.dependencies + dropped.personLinks + dropped.capacityLinks;
}

/**
 * What the chart says about the waits it did not draw, or null when it drew
 * every one it has.
 *
 * The sentence exists because the alternative is silence: the three loops in
 * {@link layOutGantt} skip a link whose other end is not on screen, and under a
 * filter somebody has been sitting in for an hour that is a bar drawn with
 * nothing holding it back — a schedule diagram that looks complete and is not
 * (`notes/wbs-brief-2026-08-17-r10-filtering.md` §8.2). Under a momentary name
 * search it was tolerable; under a filter it is the bug.
 *
 * It says **what** was dropped and not only how many, because the three kinds
 * are three different reasons a bar starts where it does, and a reader deciding
 * whether to clear the filter needs to know which one they are missing.
 *
 * Null and not an empty string: nothing to say is not something to say quietly,
 * and a caller rendering an empty `<p>` would leave a blank line under the chart
 * on every unfiltered plan.
 */
export function droppedLinkWords(dropped: DroppedLinks): string | null {
  /** `2 things`, `1 thing` — the count and its noun, which is never a bare number here. */
  const counted = (howMany: number, one: string, many: string): string =>
    `${String(howMany)} ${howMany === 1 ? one : many}`;
  const kinds: string[] = [];
  if (dropped.dependencies > 0) {
    kinds.push(counted(dropped.dependencies, 'stored dependency', 'stored dependencies'));
  }
  if (dropped.personLinks > 0) {
    kinds.push(counted(dropped.personLinks, 'person hand-off', 'person hand-offs'));
  }
  if (dropped.capacityLinks > 0) {
    kinds.push(
      counted(
        dropped.capacityLinks,
        'wait for a team to free somebody',
        'waits for a team to free somebody',
      ),
    );
  }
  if (kinds.length === 0) return null;
  const total = droppedLinkCount(dropped);
  return (
    `Not drawn: ${counted(total, 'wait', 'waits')} whose other end this filter is hiding — ` +
    `${kinds.join(', ')}. Clear the filter to see ${total === 1 ? 'it' : 'them'}.`
  );
}

/**
 * The whole chart as plain data: workdays on x, row indices on y, and not one
 * pixel anywhere.
 */
export interface GanttGeometry {
  labels: GanttRowLabel[];
  bars: GanttBar[];
  brackets: GanttSummaryBracket[];
  arrows: GanttDependencyArrow[];
  personLinks: GanttPersonLink[];
  capacityLinks: GanttCapacityLink[];
  notBeforeFlags: GanttNotBeforeFlag[];
  /** The waits this chart did not draw because the screen is not showing both ends. */
  droppedLinks: DroppedLinks;
  /**
   * How far the schedule reaches, in workdays: the latest finish of anything
   * drawn. At least 1, so an empty plan still has a viewBox with a width.
   */
  horizon: number;
}

/**
 * One reading of a workday offset: where a span that starts there stands, or
 * where one that finishes there stops.
 */
type ReadOffset = (workday: number) => number;

/**
 * One workday offset read as a calendar-day offset, two ways.
 *
 * The two readings differ only where a weekend sits between workday `w − 1` and
 * `w`, and that difference is the whole of what this chart gained: work that
 * finished on the Friday **ends** at the Saturday, while its successor
 * **starts** at the Monday, so the weekend between them is a gap a reader can
 * see. One number could not say both.
 */
export interface CalendarScale {
  /** Where a span that **starts** at this workday offset stands. */
  startOf: ReadOffset;
  /** Where a span that **finishes** at this workday offset stops. */
  endOf: ReadOffset;
}

/**
 * The scale binding the chart to the plan's first working day: workday offsets
 * in, calendar-day offsets from that day out.
 *
 * The origin is `addWorkdays(startDate, 0)` and not `startDate`, so a project
 * whose start date lands on a weekend begins on the Monday — the same
 * normalisation the Start column already makes. Inherited rather than repeated:
 * two copies of that rule are two answers about which day a plan begins on.
 *
 * `startOf(w)` walks working days for the whole part and carries the fraction
 * through untouched, so a slice 3.5 workdays into the schedule is still 3.5
 * workdays into it — the fraction rides **inside** the workday it belongs to
 * rather than being stretched across the weekend after it. `endOf(w)` is the
 * same scale's left limit: `startOf(w − 1) + 1` for a whole `w`, which is the
 * `ceil − 1` nudge `lastWorkdayOf` and be-01's `datesOf` already make.
 *
 * Offsets at or below zero are answered as themselves rather than refused: they
 * are the canvas band the marks route through (`CHART_PAD_PX`) and not schedule
 * time, and {@link addWorkdays} throws on a negative.
 *
 * Proof, twice, `gantt-geometry.test.ts`, watched 2026-08-09:
 *
 * - `endOf` aliased to `startOf` — the end reading taken as the start one.
 *   `2 failed | 51 passed`, both on `expected 7 to be 5`: `ends a span that
 *   finished on the Friday at the Saturday` and the same reading inside
 *   `begins a Saturday project on the Monday`. Every case before the first
 *   weekend stayed green, which is exactly why those two are written at 5
 *   rather than at 3.
 * - the origin taken as `startDate` instead of `addWorkdays(startDate, 0)`.
 *   `2 failed | 51 passed`: `begins a Saturday project on the Monday` on
 *   `expected 9 to be 7` — an origin two days early and every mark on the
 *   chart with it — and `refuses a start date that is not a calendar date` on
 *   `expected [Function] to throw an error`, because with no `addWorkdays` at
 *   construction the refusal is deferred to whichever mark asks first.
 *
 * And twice more for the snap, `gantt-geometry.test.ts`, watched 2026-08-10:
 *
 * - `startOf` floored the raw offset (`Math.floor(workday)`, the fraction
 *   `workday - whole`). `reads a drifted whole offset exactly as the whole
 *   day it is` failed on `expected 10.999999999999998 to be 11` — the ninth
 *   workday's mark standing a bit less than a calendar day early.
 * - `endOf` read the raw offset (`!Number.isInteger(workday)` on a drifted
 *   whole). The same test failed on `expected 21 to be 19`: a finish of
 *   15.000000000000002 was handed the **start** reading, the far side of the
 *   weekend, two calendar days past where day 15's work stops.
 *
 * @throws Whatever {@link addWorkdays} throws when `startDate` is not a
 * calendar date, and it throws here rather than at the first mark placed: a
 * scale that cannot say where day zero is has no answer to give any of them.
 */
export function calendarScale(startDate: IsoDate): CalendarScale {
  const origin = addWorkdays(startDate, 0);
  // Both readings snap before they decide anything discrete: the engine's
  // chained doubles hand this scale 8.999999999999998 for the ninth day, and a
  // bare floor put the whole part a workday early while `Number.isInteger`
  // read a drifted whole finish as a fraction — each standing a mark almost a
  // calendar day away from the dates be-01 prints beside it. The fraction that
  // survives the snap is real work and rides inside its workday untouched.
  const startOf = (workday: number): number => {
    if (workday <= 0) return workday;
    const snapped = snapWorkdays(workday);
    const whole = firstWorkdayOf(snapped);
    return calendarDaysBetween(origin, addWorkdays(origin, whole)) + (snapped - whole);
  };
  return {
    startOf,
    endOf: (workday: number): number => {
      const snapped = snapWorkdays(workday);
      return snapped <= 0 || !Number.isInteger(snapped)
        ? startOf(snapped)
        : startOf(snapped - 1) + 1;
    },
  };
}

/**
 * One bar as it is placed, and the bar the engine placed it from.
 *
 * The split is the contract: `x` and `width` are the only two numbers anything
 * about the drawing may read, and `bar` is where `data-start`, `data-finish`
 * and every sentence on hover come from. A bar's width is the span it is
 * **laid out** across and never one taken from the engine's `finish` — an
 * unestimated slice has `finish === start`, and a width from that is a mark of
 * no area at all.
 *
 * Placed is not drawn: the panel narrows this list to the estimated slices
 * before it renders anything unless the detail switch is on (`drawnBars`), so
 * at rest an unestimated bar is a box this module still sizes — and the horizon
 * still reaches — that nothing paints.
 */
export interface PlacedBar {
  bar: GanttBar;
  x: number;
  width: number;
}

/**
 * A parent's bracket as it is placed: the two ends of its projection, on the
 * calendar. **Drawn only with the detail switch on** — `gantt-declutter` took
 * the ghost bar off the parent rows and `declutter-one-button` put it behind
 * that one switch with the arrows and the assumed bars. The span is computed
 * here either way, so the horizon and the layout tests that measure it are
 * unmoved whichever way the switch is set.
 */
export interface PlacedBracket {
  rowId: string;
  rowIndex: number;
  from: number;
  to: number;
}

/** A dependency as it is drawn: the predecessor's right edge, and the successor's left one. */
export interface PlacedArrow {
  predecessorId: string;
  successorId: string;
  fromRowIndex: number;
  fromX: number;
  toRowIndex: number;
  toX: number;
}

/** One person's hand-off as it is drawn, in the colour of whoever made it. */
export interface PlacedPersonLink {
  fromSliceId: string;
  toSliceId: string;
  fromRowIndex: number;
  fromX: number;
  toRowIndex: number;
  toX: number;
  personColor: BarColor;
}

/**
 * One pool wait as it is drawn. No colour of its own to carry: every capacity
 * link on every chart is {@link CAPACITY_LINK_COLOR} — see there for why the
 * team does not get a palette.
 */
export interface PlacedCapacityLink {
  fromSliceId: string;
  toSliceId: string;
  fromRowIndex: number;
  fromX: number;
  toRowIndex: number;
  toX: number;
}

/**
 * A not-before flag as it is drawn, and the workday it holds at.
 *
 * Both, because the mark and its words answer different questions: `x` is where
 * the caret stands and `workday` is what the date beside it is worked out from.
 * A date read off `x` would name a Saturday.
 */
export interface PlacedFlag {
  rowIndex: number;
  x: number;
  workday: number;
}

/**
 * The whole chart resolved: every mark that has a horizontal coordinate,
 * carrying it, and not one workday number left standing in for one.
 *
 * The panel draws from this and from nothing else. A mark still reading
 * `bar.start` or `flag.offset` for its position is a mark that misaligns from
 * the first weekend on — and the axis, which is placed the same way, is what
 * makes it visible.
 */
export interface PlacedGantt {
  labels: GanttRowLabel[];
  bars: PlacedBar[];
  brackets: PlacedBracket[];
  arrows: PlacedArrow[];
  personLinks: PlacedPersonLink[];
  capacityLinks: PlacedCapacityLink[];
  notBeforeFlags: PlacedFlag[];
  /** How far the drawing reaches, in the unit the marks above are in. */
  horizon: number;
}

/**
 * Every mark placed through one pair of readings — a start's and a finish's.
 *
 * The whole of the conversion lives here rather than in the panel, so that
 * adding a mark to the drawing means adding it to a list that is already
 * resolved instead of remembering to convert it. `layOutGantt` is untouched and
 * stays engine-true: this reads its answer, it does not replace it.
 */
function placeGantt(chart: GanttGeometry, startOf: ReadOffset, endOf: ReadOffset): PlacedGantt {
  /**
   * Where a span running `from → to` in workdays stops.
   *
   * `endOf(to)` for a span with days in it, and its own start for one with
   * none: `endOf` answers for the last workday a span is **on**, and a span of
   * no days is on none. Without this a zero-day mark standing on a Monday
   * would stop at `endOf(w)` — the Friday's right edge, two days behind its own
   * left one — and be drawn backwards.
   */
  const stopOf = (from: number, to: number): number => (to > from ? endOf(to) : startOf(from));
  const bars = chart.bars.map((bar) => ({
    bar,
    x: startOf(bar.start),
    // The **drawn** span, read as a finish. Never a span from the engine's
    // `finish`: an unestimated slice finishes where it starts, and a width
    // from that is a bar of no area at all — the sixteenth check's own shape.
    width: stopOf(bar.start, bar.start + bar.drawnSpan) - startOf(bar.start),
  }));
  const brackets = chart.brackets.map((bracket) => ({
    rowId: bracket.rowId,
    rowIndex: bracket.rowIndex,
    from: startOf(bracket.start),
    to: stopOf(bracket.start, bracket.finish),
  }));
  const arrows = chart.arrows.map((arrow) => ({
    predecessorId: arrow.predecessorId,
    successorId: arrow.successorId,
    fromRowIndex: arrow.fromRowIndex,
    fromX: stopOf(arrow.fromStart, arrow.fromFinish),
    toRowIndex: arrow.toRowIndex,
    toX: startOf(arrow.toStart),
  }));
  const personLinks = chart.personLinks.map((link) => ({
    fromSliceId: link.fromSliceId,
    toSliceId: link.toSliceId,
    fromRowIndex: link.fromRowIndex,
    fromX: stopOf(link.fromStart, link.fromFinish),
    toRowIndex: link.toRowIndex,
    toX: startOf(link.toStart),
    personColor: link.personColor,
  }));
  const capacityLinks = chart.capacityLinks.map((link) => ({
    fromSliceId: link.fromSliceId,
    toSliceId: link.toSliceId,
    fromRowIndex: link.fromRowIndex,
    fromX: stopOf(link.fromStart, link.fromFinish),
    toRowIndex: link.toRowIndex,
    toX: startOf(link.toStart),
  }));
  const notBeforeFlags = chart.notBeforeFlags.map((flag) => ({
    rowIndex: flag.rowIndex,
    x: startOf(flag.offset),
    workday: flag.offset,
  }));

  // The reach of what is actually drawn, in the same unit the marks are in —
  // read off them rather than converted from `chart.horizon`, which is a
  // workday number and two calendar days short of an assumed span drawn over a
  // weekend. At least 1, so an empty plan still has a canvas with a width.
  let horizon = 1;
  for (const placed of bars) horizon = Math.max(horizon, placed.x + placed.width);
  for (const bracket of brackets) horizon = Math.max(horizon, bracket.to);
  for (const arrow of arrows) horizon = Math.max(horizon, arrow.fromX, arrow.toX);
  for (const flag of notBeforeFlags) horizon = Math.max(horizon, flag.x);

  return {
    labels: chart.labels,
    bars,
    brackets,
    arrows,
    personLinks,
    capacityLinks,
    notBeforeFlags,
    horizon,
  };
}

/**
 * The chart placed on the plan's calendar: every coordinate a calendar-day
 * offset from its first working day.
 *
 * Starts read {@link CalendarScale.startOf} and finishes {@link
 * CalendarScale.endOf}, which is what puts a weekend between a predecessor's
 * right edge and its successor's left one.
 *
 * @throws Whatever {@link calendarScale} throws when `startDate` is not a
 * calendar date.
 */
export function placeOnCalendar(chart: GanttGeometry, startDate: IsoDate): PlacedGantt {
  const scale = calendarScale(startDate);
  return placeGantt(chart, scale.startOf, scale.endOf);
}

/**
 * The chart placed on the workday axis: every coordinate the engine's own
 * number, verbatim.
 *
 * What a plan with no start date is drawn on. Not a fallback and not a scale of
 * one — there is no calendar to be on, so no scale is built and nothing is
 * asked for a date. See "Without a project start date the chart stays on the
 * workday axis" in the spec.
 */
export function placeOnWorkdays(chart: GanttGeometry): PlacedGantt {
  const asItIs: ReadOffset = (workday) => workday;
  return placeGantt(chart, asItIs, asItIs);
}

/**
 * Half a row down: where a line between two rows leaves, runs and arrives.
 *
 * The chart's y unit is one row, so a row's middle is its index plus this. It
 * lives here rather than beside the paint because {@link routeArrow} builds
 * whole polylines in this unit and the panel draws its person links in the
 * same one — two halves of one number is how a line and the bar it joins end
 * up on different heights.
 */
export const ROW_MIDDLE = 0.5;

/** A corner of a dependency arrow's route: `x` in the placed unit, `y` in rows. */
export interface ArrowPoint {
  x: number;
  y: number;
}

/**
 * The two numbers a route is drawn with, in the chart's own units.
 *
 * Both are the panel's and neither is derivable here. `approach` is how far a
 * line steps clear of a bar before it turns — a legibility decision the panel
 * keeps in pixels and divides by its own day scale. `barInset` is how much of
 * a row the paint leaves empty above and below a bar, which is the only thing
 * that turns a {@link PlacedBar}'s `x` and `width` into a rectangle with a top
 * and a bottom: this module places no `y` on a bar, and the router has to know
 * the whole rectangle to keep out of it.
 */
export interface ArrowClearance {
  approach: number;
  barInset: number;
}

/**
 * The rectangle a placed bar is painted as, resolved once so the crossing test
 * below reads as geometry rather than as two half-facts.
 */
interface BarRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const rectOf = (placed: PlacedBar, barInset: number): BarRect => ({
  left: placed.x,
  right: placed.x + placed.width,
  top: placed.bar.rowIndex + barInset,
  bottom: placed.bar.rowIndex + 1 - barInset,
});

/**
 * Whether a straight run between two corners passes through the **inside** of a
 * bar.
 *
 * Touching is not crossing, and the whole of the routing rests on that
 * difference: an arrow leaves its predecessor's right edge and arrives at its
 * successor's left one, so a test that counted an edge as a collision would
 * call every arrow blocked and leave {@link routeArrow} nothing to return.
 *
 * The run's **closed** box against the bar's **open** rectangle, which is the
 * one reading that stays right for a run with no thickness: a vertical run has
 * a box of no width, so an overlap asked for as positive area would find none
 * and every descent would read as clear. A horizontal run along a bar's top
 * edge is clear here; one a hair inside it is not.
 */
function runCrossesBar(from: ArrowPoint, to: ArrowPoint, rect: BarRect): boolean {
  return (
    Math.max(from.x, to.x) > rect.left &&
    Math.min(from.x, to.x) < rect.right &&
    Math.max(from.y, to.y) > rect.top &&
    Math.min(from.y, to.y) < rect.bottom
  );
}

/**
 * The heights and edges one arrow's routes are built from.
 *
 * `bandFrom` and `bandTo` are the clear insets beside the two rows — air by
 * construction, since no bar is drawn inside {@link ArrowClearance.barInset}.
 * For rows that touch they are the **same** band: a route that stepped from
 * one expression of one gap to the other would jog by an inset for nothing,
 * and the two only part when there are rows in between to cross.
 */
interface ArrowFrame {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  /** Where a route turns onto the successor's row: one approach clear of its left edge. */
  turn: number;
  bandFrom: number;
  bandTo: number;
}

const frameOf = (arrow: PlacedArrow, clearance: ArrowClearance): ArrowFrame => {
  const band = clearance.barInset / 2;
  const descending = arrow.toRowIndex > arrow.fromRowIndex;
  // The band on the side the successor is on. Not the inset above the
  // successor's own bar, which is where a not-before caret stands — the browser
  // showed those two marks crossing, and a line running through an
  // arrowhead-sized triangle makes a puzzle of both.
  const bandFrom = descending ? arrow.fromRowIndex + 1 - band : arrow.fromRowIndex + band;
  return {
    fromX: arrow.fromX,
    fromY: arrow.fromRowIndex + ROW_MIDDLE,
    toX: arrow.toX,
    toY: arrow.toRowIndex + ROW_MIDDLE,
    turn: arrow.toX - clearance.approach,
    bandFrom,
    bandTo:
      Math.abs(arrow.toRowIndex - arrow.fromRowIndex) <= 1
        ? bandFrom
        : descending
          ? arrow.toRowIndex - band
          : arrow.toRowIndex + 1 - band,
  };
};

/** A route with the corners that go nowhere dropped, so `M x y L x y` is never drawn. */
const trimmed = (corners: ArrowPoint[]): ArrowPoint[] =>
  corners.filter(
    (corner, index) =>
      index === 0 || corner.x !== corners[index - 1].x || corner.y !== corners[index - 1].y,
  );

/** The plain elbow: out along the predecessor's row, down at `column`, in along the successor's. */
const elbowThrough = (frame: ArrowFrame, column: number): ArrowPoint[] =>
  trimmed([
    { x: frame.fromX, y: frame.fromY },
    { x: column, y: frame.fromY },
    { x: column, y: frame.toY },
    { x: frame.toX, y: frame.toY },
  ]);

/**
 * The banded route: out to `exit`, into the clear band beside the predecessor's
 * row, across to `column`, down it to the band beside the successor's row, back
 * to the turn, and in.
 *
 * Every corner that goes nowhere is dropped, so for rows that touch and a
 * `column` at the turn this is the five-run jog the panel has drawn since
 * `gantt-polish`: the extra runs exist only when the crossing has to happen
 * somewhere other than under the successor's left edge.
 */
const bandedThrough = (frame: ArrowFrame, exit: number, column: number): ArrowPoint[] =>
  trimmed([
    { x: frame.fromX, y: frame.fromY },
    { x: exit, y: frame.fromY },
    { x: exit, y: frame.bandFrom },
    { x: column, y: frame.bandFrom },
    { x: column, y: frame.bandTo },
    { x: frame.turn, y: frame.bandTo },
    { x: frame.turn, y: frame.toY },
    { x: frame.toX, y: frame.toY },
  ]);

/**
 * The corners one dependency arrow is drawn through: out of the predecessor's
 * anchor, across, and into the successor's left edge from outside it — through
 * the inside of no bar on the way.
 *
 * **The invariant.** No run of the returned route passes through the interior
 * of any bar in `bars`, the two the arrow joins included; it touches those two
 * only on the edge it leaves and the edge it arrives at. That is the whole of
 * this function: the route it hands back was drawn by the panel in three points
 * for years, and three points is only clear when nothing happens to stand under
 * the column they turn at. On the A10 shape — two successors of one predecessor
 * and a fourth item waiting on both — the second arrow's descent ran straight
 * down the length of the third row's bar, because the old choice between the
 * plain elbow and the jog was made on **horizontal room alone** and never asked
 * what the descent would land on.
 *
 * **How.** Candidate columns, nearest the ideal turn first: the turn itself,
 * and one approach clear of either edge of every bar on the rows the route may
 * cross. Each is tried as a plain elbow (when there is room to turn at it),
 * then as a banded route stepping out past the predecessor, then as a banded
 * route leaving on the predecessor's own edge — the last for a predecessor
 * whose row holds another bar right against it, which is a real shape since
 * `dep-waits-on-first-role` made the arrow leave a **middle** slice.
 *
 * **Why it always has an answer.** The last candidate is a column left of every
 * bar on those rows, and the banded route through it crosses bars nowhere: the
 * bands are air by construction, the column is clear of every rectangle, the
 * run into the successor's row descends at one approach left of its start, and
 * no bar on a row starts before that row's own earliest start. The one shape
 * that defeats it is an arrow whose **start** is already strictly inside
 * another bar of its own row — two slices of one row overlapping — which no
 * route can leave without crossing; the banded fallback is returned as it
 * stands rather than a route being searched for that cannot exist.
 *
 * `bars` is what the panel actually paints, which since `gantt-declutter` is
 * the estimated ones: a bar nothing draws is not something to dodge.
 */
export function routeArrow(
  arrow: PlacedArrow,
  bars: readonly PlacedBar[],
  clearance: ArrowClearance,
): ArrowPoint[] {
  const frame = frameOf(arrow, clearance);
  const firstRow = Math.min(arrow.fromRowIndex, arrow.toRowIndex);
  const lastRow = Math.max(arrow.fromRowIndex, arrow.toRowIndex);
  // Every run of every candidate stays between the two rows the arrow joins, so
  // a bar outside them is not an obstacle and not a source of columns either.
  const obstacles = bars
    .filter((placed) => placed.bar.rowIndex >= firstRow && placed.bar.rowIndex <= lastRow)
    .map((placed) => rectOf(placed, clearance.barInset));

  const isClear = (route: ArrowPoint[]): boolean =>
    route.every(
      (corner, index) =>
        index === 0 || obstacles.every((rect) => !runCrossesBar(route[index - 1], corner, rect)),
    );

  // Left of everything on these rows, and never right of the canvas's own left
  // edge: the column the fallback below is guaranteed on.
  let clearOfEverything = 0;
  for (const rect of obstacles) clearOfEverything = Math.min(clearOfEverything, rect.left);
  clearOfEverything -= clearance.approach;

  const columns = [frame.turn];
  for (const rect of obstacles) {
    columns.push(rect.left - clearance.approach, rect.right + clearance.approach);
  }
  columns.push(clearOfEverything);
  // Nearest the ideal turn first, so a chart with nothing in the way is drawn
  // exactly as it was and a dodge is the smallest one that clears.
  const ordered = [...new Set(columns)].sort(
    (one, other) => Math.abs(one - frame.turn) - Math.abs(other - frame.turn),
  );

  for (const column of ordered) {
    // Room to turn at this column: one approach out of the predecessor and one
    // into the successor. Without it the elbow collapses onto the successor's
    // left edge, under its own bar — `gantt-polish`'s fault, and why the banded
    // routes exist at all.
    if (column >= arrow.fromX + clearance.approach && column <= frame.turn) {
      const elbow = elbowThrough(frame, column);
      if (isClear(elbow)) return elbow;
    }
    for (const exit of [arrow.fromX + clearance.approach, arrow.fromX]) {
      const banded = bandedThrough(frame, exit, column);
      if (isClear(banded)) return banded;
    }
  }

  return bandedThrough(frame, arrow.fromX, clearOfEverything);
}

/**
 * What each floor says on a bar's hover card, in the reader's words.
 *
 * `predecessor` used to read "Waits for a dependency to finish", which stopped
 * being true at `dep-waits-on-first-role` (2026-08-11): the wait is on the
 * predecessor's **anchor** — its first estimated role — and the roles behind
 * that anchor run alongside this bar. A card saying "to finish" beside an
 * arrow leaving the middle of the predecessor is the chart contradicting
 * itself, so it names the anchor instead, in the same shape as the sibling
 * below it.
 */
const FLOOR_SENTENCE: Record<Exclude<BindingFloor, 'person' | 'capacity'>, string> = {
  projectStart: 'Starts with the project',
  predecessor: 'Waits for a dependency’s first estimated role',
  roleOrder: 'Waits for an earlier role on this item',
  notBefore: 'Held by its start-no-earlier-than date',
};

/**
 * What a sentence about *another* row calls that row.
 *
 * **A work item is created with no name and named later** — be-01's `create`
 * takes one optionally, the column's own input is labelled `Name of 010`, and
 * a row can sit unnamed for as long as its planner likes. So `row.name` is an
 * empty string on real plans and not only in a fixture, and the three floor
 * sentences that point at a neighbour would print `Waits for  (Dev)`: a hole
 * where the referent goes, in the one place a reader will read it as the tool
 * being broken. That is the fault {@link predecessorFloorWords}' `(null)` arm
 * already refuses for the *role*, arriving through the other half of the name.
 *
 * **The number and not `(unnamed)`**, which is the one judgement here.
 * `wbs-table.tsx`'s `namedInTheTree` says `<number> (unnamed)` and is right for
 * a chip, whose job is to list; a sentence has to let the reader *find* the row
 * it blames, and `(unnamed)` names nothing while `010` names exactly one row —
 * the token the card's own `waits for 010` line prints two lines above this
 * sentence, and the table's `Deleted 010 — Cmd+Z restores`. A named row is
 * untouched: the sentences stay `Waits for Strip (Dev)` rather than growing a
 * number nobody asked for on the surface where they are already 54 characters.
 *
 * Absence still means absence. A predecessor missing from `plan.rows` is
 * `undefined` from these maps, which is the *row is not in the payload* state
 * each caller has its own words for; this only fills a name that is present
 * and empty.
 */
function spokenNameOf(row: GanttRow): string {
  return row.name === '' ? row.number : row.name;
}

/**
 * The sentence a not-before-floored bar shows: the floor, and — where somebody
 * wrote one — why it is there.
 *
 * Reads: _"Held by its start-no-earlier-than date — waiting on client
 * sign-off"_. The em-dash and the lower-case continuation are
 * {@link personFloorWords}' and
 * {@link capacityFloorWords}' shape, deliberately: three floors that explain
 * themselves should explain themselves in one voice, and a reader moving
 * between bars should not have to notice which kind they are hovering.
 *
 * **The reason is appended, never substituted.** The date is still what holds
 * the bar and the sentence still says so; the words are an aside on a floor
 * that reads identically without them. That is the whole of what this feature
 * is — `notes/decisions.md`, 2026-08-18: the engine already models being held
 * back, so nothing new holds anything back, and a second sentence would be a
 * second vocabulary for one bar.
 *
 * Printed verbatim, punctuation and capitals as typed: it is somebody's own
 * sentence, and be-01 has already trimmed it and bounded it at 200 characters.
 * A row with no reason reads exactly what every not-before bar read before this
 * existed, which is what makes this change invisible on every plan nobody has
 * explained.
 */
/**
 * The sentence a dependency-floored row shows: which dependency, and the day it
 * stops holding this one.
 *
 * Reads _"Waits for Strip (Dev) — finishes 25 Sep"_. The em-dash and the
 * lower-case continuation are {@link personFloorWords}' and
 * {@link capacityFloorWords}' shape, for their reason: four floors that explain
 * themselves should explain themselves in one voice.
 *
 * **The generic sentence is the floor of this one, not a fallback beside it.**
 * `Waits for a dependency’s first estimated role` is what every predecessor-
 * floored surface said before this existed, and it is still what a caller that
 * cannot resolve the anchor gets — the chart, which does not yet ask, and any
 * row whose predecessor left the payload with its rows. So a surface never
 * loses the fact; it gains the name, and then the day.
 *
 * **The day is the anchor's last working day**, `lastWorkdayOf` over the same
 * span be-01's `datesOf` prints the `End` column from, so the date in this
 * sentence is a date the plan already shows somewhere else. For a whole-day
 * anchor that day is the workday **before** the successor's own start, so the
 * sentence names a date the cell beside it does not already carry. A
 * fractional anchor finishes mid-day, the successor picks up on the *same*
 * workday, and saying `finishes 3 Nov` beside a cell that reads `3 Nov` answers
 * nothing — the exact reading the parent task was opened to remove — so that
 * arm says `finishes **during** 3 Nov` instead: the date kept, the handoff
 * named as within the day. A caller with no calendar — a plan with no start
 * date, drawn on the workday axis — names the wait and says no day, rather
 * than inventing one.
 */
function predecessorFloorWords(
  anchor: PlacedSlice | undefined,
  clearsOn: string | null,
  startsOn: string | null,
  rowNames: ReadonlyMap<string, string>,
): string {
  if (anchor === undefined) return FLOOR_SENTENCE.predecessor;
  const workItemName = rowNames.get(anchor.slice.workItemId);
  if (workItemName === undefined) return FLOOR_SENTENCE.predecessor;
  // The role in brackets where the anchor has one, and the work item alone
  // where it does not — {@link personFloorWords}' own two arms, for its reason:
  // a slice belonging to no role is a real state on this wire, and `(null)`
  // beside a name is the sentence saying so in the one place a reader will read
  // as a fault in the tool.
  const named =
    anchor.roleName === null
      ? `Waits for ${workItemName}`
      : `Waits for ${workItemName} (${anchor.roleName})`;
  if (clearsOn === null) return named;
  // A whole-day anchor stops the workday before the successor starts, so the
  // date is new information. A fractional one stops on the successor's own
  // start day, and `finishes <date>` would repeat the figure in the cell
  // beside this one.
  return clearsOn === startsOn
    ? `${named} — finishes during ${clearsOn}`
    : `${named} — finishes ${clearsOn}`;
}

function notBeforeFloorWords(reason: string | null): string {
  // Proof: this arm replaced by an unconditional
  // `${FLOOR_SENTENCE.notBefore} — ${String(reason)}` — **3 failed, 101
  // passed** — `says only the floor for a not-before nobody has explained`, the
  // four-floor case `says in words what a start is held by`, and the panel's
  // own `holds a not-before flag at its exact offset`, each on `expected 'Held
  // by its start-no-earlier-than date — null' to be 'Held by its
  // start-no-earlier-than date'`. That is the word `null` on the hover card of
  // every dated row in every plan, which is every such row today — and the
  // spread of the failure is the point: nothing about this feature is what
  // three of those cases are about. Watched 2026-08-18.
  if (reason === null) return FLOOR_SENTENCE.notBefore;
  return `${FLOOR_SENTENCE.notBefore} — ${reason}`;
}

/**
 * The sentence a person-floored bar shows: who was in the way, and what they
 * were finishing.
 *
 * The predecessor slice is always in the payload — {@link layOutGantt}
 * refuses one that is not — but its **row** may be collapsed away or narrowed
 * off by a search, and then there is no name to print. That absence is
 * modeled and says so in the words rather than being papered over with the
 * person's name alone.
 *
 * `person` arrives resolved: {@link personNameOf} is what refuses a slice
 * assigned to somebody the plan does not name, and it does so for every bar
 * rather than for the person-floored ones alone. A second check here would be
 * one nothing could ever reach.
 */
function personFloorWords(
  person: string,
  predecessor: GanttSlice,
  rowNames: ReadonlyMap<string, string>,
  rolesById: ReadonlyMap<string, GanttRolePlace>,
): string {
  const workItemName = rowNames.get(predecessor.workItemId);
  if (workItemName === undefined) return `${person} — after work that is not shown`;
  const roleName =
    predecessor.roleId === null ? undefined : rolesById.get(predecessor.roleId)?.name;
  return roleName === undefined
    ? `${person} — after ${workItemName}`
    : `${person} — after ${workItemName} (${roleName})`;
}

/**
 * What this module calls a team the directory read does not hold yet.
 *
 * Word for word what `plan-cards.tsx` prints for the same state, and repeated
 * rather than imported: the card and the bar are two surfaces of one skew and
 * a reader who sees both should read the same sentence twice, but a value
 * import from the geometry into the cards would tie a pure layout module to a
 * component's copy for one string. If either moves, the other is a grep away.
 */
const STALE_TEAM_WORDS = 'a team this plan has not loaded';

/**
 * What a bar's pool sentence calls the team, or null where there is no team to
 * call anything.
 *
 * The two nameless states are not the same fact and this is where they part.
 * `unresolved` is the **modeled** skew {@link ServiceTeamLabel} describes — the
 * label rides the tree read and the names ride the directory read, so a team
 * created between the two is a stale lookup that the next read heals — and it
 * degrades into words, the same words `plan-cards.tsx` prints and beside the
 * export's `(unknown)`. `none` on a capacity-floored bar is a payload that has
 * lost the label the pool was keyed on: be-01 floors on a team or not at all,
 * so there is no team here to be short of, and the caller throws rather than
 * inventing one.
 *
 * Proof: this arm returning `null` again for `unresolved`, so the caller's
 * no-team throw catches it — `carries words for a team the directory read has
 * not caught up with` and the panel's `still draws when the directory read has
 * not caught up with the pool` failed, the second on `expected 'The chart
 * cannot be drawn: slice seal…' to be null` against `GanttDataError: slice
 * sealing::role-dev is floored by a team's capacity but its row names no team`.
 * Watched 2026-08-13.
 */
function poolNameOf(team: ServiceTeamLabel): string | null {
  switch (team.state) {
    case 'named':
    case 'inherited':
      return team.name;
    case 'unresolved':
      return STALE_TEAM_WORDS;
    case 'none':
      return null;
  }
}

/**
 * The sentence a capacity-floored bar shows: whose people ran out, how many
 * this slice needs, and which slice freeing them let it start.
 *
 * The **display referent** is named and the rest of the blocking set is
 * counted: be-01 sends every reservation that had to end for this block to fit
 * (`capacityPredecessorIds`) and picks the latest finisher of them as the id an
 * arrow is drawn from. Naming one and counting the others is the honest
 * reading of a disjunctive wait — "at least one of these had to move" — and a
 * card listing five rows is a card nobody finishes.
 *
 * The referent's **row** may be collapsed away or narrowed off by a search,
 * exactly as {@link personFloorWords}' can, and that absence is said in words
 * rather than papered over.
 */
function capacityFloorWords(
  team: string,
  width: number,
  referent: GanttSlice,
  otherBlockers: number,
  rowNames: ReadonlyMap<string, string>,
  rolesById: ReadonlyMap<string, GanttRolePlace>,
): string {
  const people = width === 1 ? 'a person' : `${String(width)} people`;
  const workItemName = rowNames.get(referent.workItemId);
  const roleName = referent.roleId === null ? undefined : rolesById.get(referent.roleId)?.name;
  const after =
    workItemName === undefined
      ? 'work that is not shown'
      : roleName === undefined
        ? workItemName
        : `${workItemName} (${roleName})`;
  // "and 2 others" and not "and 2 more blockers": the reader is being told how
  // many other bars were holding the pool, and the count is of the set minus
  // the one just named.
  //
  // The singular is not a nicety. A blocking set of exactly two is the
  // commonest non-trivial case — a pool of 2 with a width-2 block behind it —
  // so `and 1 others` was the wording most readers met first. C3 recorded it as
  // a P3 and `capacity-docs` is where copy gets fixed.
  const others =
    otherBlockers === 0
      ? ''
      : ` and ${String(otherBlockers)} other${otherBlockers === 1 ? '' : 's'}`;
  return `Waits for ${team} to free ${people} — after ${after}${others}`;
}

/**
 * Whose slice this is, or null when nobody's.
 *
 * @throws GanttDataError when the slice names a person the plan does not. The
 * payload carries the assignment and the roster in one read, so a personId
 * with no name is the wire having lost one of them — and the bar's colour and
 * its on-bar label are both that name, so a chart drawn anyway would be a
 * chart with an anonymous colour on it.
 */
function personNameOf(slice: GanttSlice, personNames: ReadonlyMap<string, string>): string | null {
  if (slice.personId === null) return null;
  const name = personNames.get(slice.personId);
  // Proof: this throw replaced by `return name ?? slice.personId`, so an
  // unknown person drew under their own id. **Two** tests failed, `2 failed |
  // 39 passed`, both on `expected function to throw an error, but it didn't`:
  // `throws when a slice is assigned to somebody the plan does not name` and
  // `throws when a person floor names somebody the plan does not` — the second
  // is the check this one replaced in `personFloorWords`, and it is here that
  // it now fires. Watched 2026-08-09.
  if (name === undefined) {
    throw new GanttDataError(
      `slice ${slice.id} is assigned to ${slice.personId}, whom this plan does not name`,
    );
  }
  return name;
}

/**
 * Every mark the Gantt panel draws, from the rows it is showing, the payload's
 * slices and the plan's dependencies — in workdays on x and row indices on y.
 *
 * Pure: no DOM, no React, no fetching, and no schedule math. Engine numbers
 * pass through verbatim, fractions included, because the panel's SVG user
 * space *is* the workday axis and any arithmetic here is a rounding waiting to
 * disagree with the Start/End columns.
 *
 * What is missing and what is broken are different answers. A slice whose
 * work item is not among {@link GanttPlan.rows} is on a collapsed branch or
 * behind a filter: its bar is skipped, and so are the person link and the
 * dependency arrow that would have ended on it — **and each of those skips is
 * counted** into {@link GanttGeometry.droppedLinks}, so the panel can say what
 * it did not draw instead of leaving a bar with nothing visibly holding it back
 * (F3). A `resourcePredecessorId`
 * that names no slice **in the payload** is a broken promise and throws —
 * the row it belongs to may well be on screen, and a chart quietly short one
 * hand-off is the chart lying about who is waiting for whom.
 *
 * @throws GanttDataError on a dangling `resourcePredecessorId`, a
 * person-floored slice with no resource predecessor or an unnamed person, a
 * slice under a role the plan does not list, and a dependency between shown
 * rows whose predecessor has no slice in the payload to anchor its arrow.
 */
export function layOutGantt(plan: GanttPlan): GanttGeometry {
  const rowNames = new Map(plan.rows.map((row) => [row.id, spokenNameOf(row)]));
  const placedRows = new Map(plan.rows.map((row, rowIndex) => [row.id, { row, rowIndex }]));
  const sliceById = new Map(plan.slices.map((slice) => [slice.id, slice]));
  const rolesById: ReadonlyMap<string, GanttRolePlace> = new Map(
    plan.roles.map((role, place) => [role.id, { place, name: role.name }]),
  );

  const predecessorOf = new Map<string, GanttSlice>();
  for (const slice of plan.slices) {
    if (slice.resourcePredecessorId === null) continue;
    const predecessor = sliceById.get(slice.resourcePredecessorId);
    // Proof: this throw replaced by a `continue`, so a dangling id was skipped
    // exactly as a hidden one is — `throws when a resource predecessor names no
    // slice in the payload` and `throws on a dangling resource predecessor even
    // where no bar would be drawn` both failed; watched 2026-08-09.
    if (predecessor === undefined) {
      throw new GanttDataError(
        `slice ${slice.id} names resource predecessor ${slice.resourcePredecessorId}, ` +
          `which is not a slice in this payload`,
      );
    }
    predecessorOf.set(slice.id, predecessor);
  }

  const labels: GanttRowLabel[] = plan.rows.map((row, rowIndex) => ({
    id: row.id,
    number: row.number,
    name: row.name,
    depth: row.depth,
    rowIndex,
  }));

  const slicesByWorkItem = new Map<string, GanttSlice[]>();
  for (const slice of plan.slices) {
    const own = slicesByWorkItem.get(slice.workItemId);
    if (own === undefined) slicesByWorkItem.set(slice.workItemId, [slice]);
    else own.push(slice);
  }

  const bars: GanttBar[] = [];
  const barBySliceId = new Map<string, GanttBar>();
  const brackets: GanttSummaryBracket[] = [];
  const notBeforeFlags: GanttNotBeforeFlag[] = [];

  /**
   * The palette, handed out as the rows are walked.
   *
   * First appearance top-down, which makes the colours a fact about **what is
   * on screen**: collapse a branch whose only person was drawn first and the
   * people below shift up the palette. That is deliberate — the alternative is
   * an order taken from the payload's slice array, which is the engine's
   * placement order and would put the top row's person in whatever colour the
   * scheduler happened to reach them in. Within one drawing every row agrees,
   * which is the property a reader uses.
   *
   * Proof that the **order** is the rows' and not somebody's idea of a stable
   * one: the map pre-seeded from `[...new Set(plan.slices.map((s) =>
   * s.personId))].sort()` before this walk — alphabetical by person id, which
   * is stable and wrong. `hands the palette out in the order people first
   * appear, top-down` failed on `expected [ '#ff7f0e', '#1f77b4' ] to deeply
   * equal [ '#1f77b4', '#ff7f0e' ]`, `wraps the eleventh person…` with it, and
   * `gives one person one colour on every row they are on` went on passing —
   * that one cannot see this fault, which is why the order has a test of its
   * own. Watched 2026-08-09.
   */
  const colorByPerson = new Map<string, BarColor>();
  const colorFor = (personId: string | null): BarColor => {
    // Proof: replaced by `return PERSON_BAR_COLORS[0]`, so an unassigned slice
    // drew as the first person. `paints a slice nobody is on grey, and does not
    // spend a colour on it` alone failed, on `expected '#1f77b4' to be
    // '#94a3b8'`; watched 2026-08-09.
    if (personId === null) return UNASSIGNED_BAR_COLOR;
    const taken = colorByPerson.get(personId);
    if (taken !== undefined) return taken;
    // Wrapping rather than running out: `% length` is what an eleventh person
    // gets, and it is the first colour again.
    //
    // Proof, twice. The `%` dropped: `wraps the eleventh person back onto the
    // first colour` alone failed, on `expected undefined to be '#1f77b4'` — an
    // eleventh person with no colour at all rather than a shared one. And the
    // `set` below removed, so nothing was remembered: **3** failed, `3 failed |
    // 38 passed`, on `expected '#1f77b4' not to be '#1f77b4'` and two lists of
    // one repeated colour. Watched 2026-08-09.
    const next = PERSON_BAR_COLORS[colorByPerson.size % PERSON_BAR_COLORS.length];
    colorByPerson.set(personId, next);
    return next;
  };

  plan.rows.forEach((row, rowIndex) => {
    if (row.notBeforeOffset !== null) {
      notBeforeFlags.push({ rowIndex, offset: row.notBeforeOffset });
    }
    if (!row.leaf) {
      // The projection, taken whole: a parent's bracket is a span, and be-01
      // already computed it as one. Nothing here adds up what is underneath.
      //
      // Proof: this replaced by a walk over the rows beneath this one summing
      // their slices' durations onto `earliestStart` — `is a span and not the
      // sum of what is under it` failed with 7 where the branch runs 0→6, and
      // `spans a parent over staggered children` and `reaches as far as the
      // latest finish of anything drawn` with it; watched 2026-08-09.
      brackets.push({
        rowId: row.id,
        rowIndex,
        start: row.schedule.earliestStart,
        finish: row.schedule.earliestFinish,
      });
      return;
    }
    const own = slicesByWorkItem.get(row.id) ?? [];
    for (const { slice, roleName } of inRoleOrder(own, rolesById)) {
      const predecessor = predecessorOf.get(slice.id);
      const personName = personNameOf(slice, plan.personNames);
      const bar: GanttBar = {
        sliceId: slice.id,
        rowIndex,
        start: slice.earliestStart,
        finish: slice.earliestFinish,
        duration: slice.duration,
        // The only place the drawing parts from the engine, and it parts from
        // it here rather than in the panel so the horizon below can contain
        // what is actually drawn. See {@link ASSUMED_UNESTIMATED_WORKDAYS}.
        drawnSpan: slice.estimated ? slice.duration : ASSUMED_UNESTIMATED_WORKDAYS,
        float: slice.float,
        critical: slice.critical,
        estimated: slice.estimated,
        workItemNumber: row.number,
        workItemName: row.name,
        roleName,
        personName,
        personColor: colorFor(slice.personId),
        floorWords: floorWordsOf(
          slice,
          predecessor,
          personName,
          row.team,
          // `?? null` and not a required field: the row that carries this is
          // built in `wbs-table.tsx`, which owes the one line that fills it —
          // see {@link GanttRow.notBeforeReason}.
          row.notBeforeReason ?? null,
          rowNames,
          rolesById,
          // The chart does not yet ask which dependency holds this bar, and
          // asking costs it a per-bar walk of every stored edge; its arrow
          // already draws the answer from the anchor this would name. So the
          // hover keeps the words it has always had, and the table — which has
          // no arrow — is the surface that spends the walk. Deliberate and
          // dated: `row-floor-names-the-dep`, 2026-08-23.
          undefined,
          null,
          null,
        ),
        team: row.team,
        // Straight off the row and into words. Deliberately **not** passed to
        // `floorWordsOf` above: that sentence says what is holding this bar up,
        // and a tag has never held anything up.
        //
        // Proof: this line replaced by `tags: { state: 'none' }` — the bar
        // built, drawn and placed identically, saying only that the work is of
        // no particular kind. `2 failed | 106 passed` in
        // `gantt-geometry.test.ts`, on `expected { state: 'none' } to deeply
        // equal { state: 'inherited', …(2) }`. Watched on h2puni, 2026-08-20.
        tags: row.tags,
        // The engine's own two numbers, carried rather than recomputed: the
        // width the dates were placed with and the effort they were placed
        // from. `duration` above is `effort / width` in be-01's doubles, and a
        // division redone here would print a plan the tool does not hold.
        width: slice.width,
        maxParallel: row.maxParallel,
        effort: slice.effort,
        // The bar's own role's trio. A slice under no role has no estimate to
        // look up rather than an empty one, which is the same absence said
        // once.
        trio: (slice.roleId === null ? undefined : row.trioByRole.get(slice.roleId)) ?? null,
        waitsFor: row.waitsFor,
        priority: row.priority,
      };
      bars.push(bar);
      barBySliceId.set(slice.id, bar);
    }
  });

  /**
   * The waits skipped below because one of their ends is not on this chart —
   * counted here and said out loud by the panel, never redrawn (F3, §9's Q7).
   *
   * Mutated by the three loops that already `continue` past those links, which
   * is the whole of why the count cannot drift from the drawing: it is taken at
   * the moment the link is dropped rather than worked out a second time from
   * the rows.
   */
  const droppedLinks: DroppedLinks = { ...NO_DROPPED_LINKS };

  const personLinks: GanttPersonLink[] = [];
  for (const slice of plan.slices) {
    if (slice.boundBy !== 'person') continue;
    const predecessor = predecessorOf.get(slice.id);
    if (predecessor === undefined) continue;
    const waiting = barBySliceId.get(slice.id);
    const busy = barBySliceId.get(predecessor.id);
    if (waiting === undefined || busy === undefined) {
      // One end drawn and the other not: a bar on screen is waiting on work the
      // reader cannot see. Neither end drawn is not counted — nothing on screen
      // lost a mark. Proof: all three `!==` pairs struck for an unconditional
      // `+= 1`, `counts nothing for a link with neither end on screen` failed
      // alone across the two chart files — `1 failed | 214 passed`. Watched,
      // 2026-08-17.
      if (waiting !== undefined || busy !== undefined) droppedLinks.personLinks += 1;
      continue;
    }
    personLinks.push({
      fromSliceId: predecessor.id,
      fromRowIndex: busy.rowIndex,
      fromStart: busy.start,
      fromFinish: busy.finish,
      toSliceId: slice.id,
      toRowIndex: waiting.rowIndex,
      toStart: waiting.start,
      // The waiting bar's own colour, read off the bar rather than looked up
      // again: the line and the two ends it joins cannot be different colours
      // for the same person if only one of them decides.
      personColor: waiting.personColor,
    });
  }

  /**
   * The pool waits whose both ends are on the chart.
   *
   * The same shape as the loop above and the same skips, for the same reasons —
   * a link onto a slice that is not drawn would run to a point on an empty row.
   * What it is **not** is a second reading of the sentence: the id is
   * `resourcePredecessorId`, which is be-01's own choice of display referent
   * out of the blocking set, and the "and N others" on the hover is a count of
   * a set no line is drawn for. One wait, one line.
   */
  const capacityLinks: GanttCapacityLink[] = [];
  for (const slice of plan.slices) {
    if (slice.boundBy !== 'capacity') continue;
    const referent = predecessorOf.get(slice.id);
    if (referent === undefined) continue;
    const waiting = barBySliceId.get(slice.id);
    const freeing = barBySliceId.get(referent.id);
    if (waiting === undefined || freeing === undefined) {
      // Counted exactly as the hand-off above is, and for the same reason.
      if (waiting !== undefined || freeing !== undefined) droppedLinks.capacityLinks += 1;
      continue;
    }
    capacityLinks.push({
      fromSliceId: referent.id,
      fromRowIndex: freeing.rowIndex,
      fromStart: freeing.start,
      fromFinish: freeing.finish,
      toSliceId: slice.id,
      toRowIndex: waiting.rowIndex,
      toStart: waiting.start,
    });
  }

  const leavesUnder = leavesUnderOf(plan.tree);

  /**
   * The predecessor's anchor span, **selected** from the payload's slices and
   * never recomputed from estimates (design.md D6): a leaf's first slice in
   * role order **that somebody estimated**, its last slice when nobody
   * estimated any of them, and for a parent the latest-finishing anchor among
   * its leaves. An id the tree does not hold reads as a leaf — its own
   * slices — which for a parent finds none and lands on the throw below.
   *
   * The walk is be-01's, read off the `estimated` flag the wire already
   * carries rather than off any number this file works out for itself, so the
   * arrow leaves the slice the engine actually joined the edge to. The two
   * agreeing is not left to inspection: `an arrow leaves the first estimated
   * role, not the unestimated one in front of it` pins it against a payload
   * shaped like the engine's own probe.
   *
   * @throws GanttDataError when a leaf under the predecessor has no slice in
   * the payload. Not a collapsed row — that absence is modeled on `rows`, and
   * the caller skipped it before asking. be-01 emits at least one slice for
   * every leaf, so a shown predecessor with none anywhere is a broken
   * promise, and an arrow silently dropped would hide exactly the wait the
   * chart exists to show.
   *
   * Proof: this throw replaced by a skip — the anchorless edge dropped the
   * way a hidden row's is — and `throws when a shown predecessor has no slice
   * in the payload at all` alone failed, `1 failed | 66 passed`, on `expected
   * function to throw an error, but it didn't`: the chart came back quietly
   * short one arrow. Watched 2026-08-11.
   */
  const anchorSpanOf = (
    predecessorId: string,
    successorId: string,
  ): { start: number; finish: number } => {
    const anchor = anchorSliceOf(
      predecessorId,
      leavesUnder,
      slicesByWorkItem,
      rolesById,
      (leafId) =>
        `dependency ${predecessorId} → ${successorId}: ${leafId} has no slice in this ` +
        `payload, so the arrow has no anchor to leave from`,
    );
    return { start: anchor.slice.earliestStart, finish: anchor.slice.earliestFinish };
  };

  const arrows: GanttDependencyArrow[] = [];
  for (const edge of plan.dependencies) {
    const from = placedRows.get(edge.predecessorId);
    const to = placedRows.get(edge.successorId);
    if (from === undefined || to === undefined) {
      // The stored half of the same count. `dependencies` is now **every** edge
      // the plan holds rather than the shown rows' own (`wbs-table.tsx`), so an
      // arrow leaving a bar on screen for a hidden successor is counted here
      // too — before F3 that edge never reached this loop at all, and the bar
      // it left lost its arrow with nothing anywhere saying so.
      if (from !== undefined || to !== undefined) droppedLinks.dependencies += 1;
      continue;
    }
    const anchor = anchorSpanOf(edge.predecessorId, edge.successorId);
    arrows.push({
      predecessorId: edge.predecessorId,
      successorId: edge.successorId,
      fromRowIndex: from.rowIndex,
      fromStart: anchor.start,
      fromFinish: anchor.finish,
      toRowIndex: to.rowIndex,
      toStart: to.row.schedule.earliestStart,
    });
  }

  let horizon = 1;
  // Both ends of every bar: where the engine finishes it, and where the drawing
  // does. An unestimated slice standing on the last workday is drawn
  // {@link ASSUMED_UNESTIMATED_WORKDAYS} past its own finish, and a horizon
  // taken from `finish` alone would end the canvas underneath it —
  // `CHART_PAD_PX` in the panel is a band for pixel excursions and is not a
  // workday span to hide a bar in.
  for (const bar of bars) horizon = Math.max(horizon, bar.finish, bar.start + bar.drawnSpan);
  for (const bracket of brackets) horizon = Math.max(horizon, bracket.finish);
  for (const arrow of arrows) horizon = Math.max(horizon, arrow.fromFinish, arrow.toStart);
  for (const flag of notBeforeFlags) horizon = Math.max(horizon, flag.offset);

  return {
    labels,
    bars,
    brackets,
    arrows,
    personLinks,
    capacityLinks,
    notBeforeFlags,
    droppedLinks,
    horizon,
  };
}

/** One role as the drawing reads it: where it comes in the plan's order, and what it is called. */
interface GanttRolePlace {
  place: number;
  name: string;
}

/** One of a leaf's slices with its role resolved: the bar's place in the row, and the role's name. */
interface PlacedSlice {
  slice: GanttSlice;
  place: number;
  roleName: string | null;
}

/**
 * One leaf's slices in the order its bars sit in: the order the plan lists
 * the roles in, with a slice belonging to no role last.
 *
 * A work item with no roles still gets a slice — it has to be somewhere in the
 * plan — and it has no place among the roles, so it takes the end.
 *
 * @throws GanttDataError when a slice names a role the plan does not list.
 */
function inRoleOrder(
  slices: readonly GanttSlice[],
  rolesById: ReadonlyMap<string, GanttRolePlace>,
): PlacedSlice[] {
  // Every place is looked up before the sort rather than inside its comparator:
  // `sort` does not call a comparator for a list of one, so a leaf with a single
  // slice would never have its role resolved and the throw below could not fire
  // on the commonest row in any plan. Watched: with the lookup in the
  // comparator, `throws when a slice is under a role the plan does not list`
  // passed against a slice under role `ops` on a plan that lists Dev and QA.
  const placed = slices.map((slice) => placeOf(slice, rolesById));
  // `sort` is stable, so slices sharing a place — the ones belonging to no role
  // — keep the order the payload had them in.
  return placed.sort((one, other) => one.place - other.place);
}

/**
 * Where a slice's bar sits among its row's bars, and what its role is called:
 * its role's place in the plan's list, and last and nameless when it belongs to
 * no role.
 *
 * @throws GanttDataError when the slice names a role the plan does not list.
 */
function placeOf(slice: GanttSlice, rolesById: ReadonlyMap<string, GanttRolePlace>): PlacedSlice {
  if (slice.roleId === null) {
    return { slice, place: Number.MAX_SAFE_INTEGER, roleName: null };
  }
  const role = rolesById.get(slice.roleId);
  // Proof: this throw replaced by
  // `return { slice, place: Number.MAX_SAFE_INTEGER, roleName: null }` — the
  // unlisted role treated as no role at all. `throws when a slice is under a
  // role the plan does not list` alone failed, on `expected function to throw
  // an error, but it didn't`; re-watched 2026-08-09 in this shape.
  if (role === undefined) {
    throw new GanttDataError(
      `slice ${slice.id} is under role ${slice.roleId}, which this plan does not list`,
    );
  }
  return { slice, place: role.place, roleName: role.name };
}

/**
 * A slice's binding floor in words.
 *
 * A `switch` over the whole union rather than an index into
 * {@link FLOOR_SENTENCE}, and the difference is the `default`. `boundBy`
 * arrives on the wire: the type says six values because that is what be-01
 * sends **today**, and a seventh floor added there — a resource calendar, a
 * fixed date — reaches this module as a string the drawing has no words for.
 * Indexed, it produced `undefined`, and the bar's hover text ended on a bare
 * newline: the one thing the panel exists to say, silently missing. So an
 * unrecognised floor is malformed trusted data like every other broken promise
 * in this file, and it throws into the same error boundary.
 *
 * The sixth — `capacity` — is the one this build learned last, and it is why
 * `capacity-write-paths` could merge but not deploy: be-01 has been able to
 * send it since a team could be given a size, and until this case existed the
 * `default:` below took every such plan's chart into the error boundary.
 *
 * @throws GanttDataError when a person-floored slice names no resource
 * predecessor. `boundBy: 'person'` means the assignee's last finish was
 * strictly the latest floor, so there is always a slice they were finishing;
 * a payload saying otherwise has lost the one fact the person link is drawn
 * from.
 * @throws GanttDataError when a capacity-floored slice names no blocking set,
 * no display referent, or no team. Each of the three is a fact the sentence is
 * built from — whose pool, how full, and which finish let this in — and
 * be-01's own invariant is that a capacity floor has all three
 * (`schedule.ts`'s `boundBy: 'capacity'` ⟺ non-empty blocking set).
 * @throws GanttDataError on a floor this module does not know.
 */
function floorWordsOf(
  slice: GanttSlice,
  predecessor: GanttSlice | undefined,
  personName: string | null,
  team: ServiceTeamLabel,
  notBeforeReason: string | null,
  rowNames: ReadonlyMap<string, string>,
  rolesById: ReadonlyMap<string, GanttRolePlace>,
  dependencyAnchor: PlacedSlice | undefined,
  clearsOn: string | null,
  startsOn: string | null,
): string {
  switch (slice.boundBy) {
    case 'projectStart':
    case 'roleOrder':
      return FLOOR_SENTENCE[slice.boundBy];
    // The one arm whose words depend on facts this function is not handed by
    // every caller. `dependencyAnchor` is the binding edge's anchor where the
    // caller resolved one and `undefined` where it did not ask, and the
    // sentence degrades to what it has always been rather than to silence.
    case 'predecessor':
      return predecessorFloorWords(dependencyAnchor, clearsOn, startsOn, rowNames);
    // The one floor of the four that has words of its own. It is here and not
    // beside the other three because the reason belongs to the **row** rather
    // than to the slice: a work item's not-before holds every one of its roles,
    // so each bar of that row that is floored by it says the same sentence.
    case 'notBefore':
      return notBeforeFloorWords(notBeforeReason);
    case 'capacity': {
      // The display referent, and the same refusal the person arm makes one
      // case above: a bar whose date came from a wait names what it waited for,
      // or the payload has lost the reason for its own start.
      //
      // Proof: this throw replaced by `return 'Waits for a team'`, `throws when
      // a capacity floor names no display referent` alone failed, on `expected
      // function to throw an error, but it didn't`. Watched 2026-08-13.
      if (predecessor === undefined) {
        throw new GanttDataError(
          `slice ${slice.id} is floored by a team's capacity but names no display referent`,
        );
      }
      // The whole blocking set, which the referent is one of. be-01 cannot
      // produce a capacity floor with an empty set — the floor is only reached
      // by a scan that recorded who was holding the pool — so an empty one here
      // is malformed trusted data, and `?? 0` in its place would print "and 0
      // others" over a sentence with no cause behind it.
      //
      // Proof: this throw deleted and the count clamped with `Math.max(0, …)`
      // in its place — the shape a defensive fix would take — `throws when a
      // capacity floor says nothing was holding the pool` alone failed, on
      // `expected function to throw an error, but it didn't`. Watched
      // 2026-08-13.
      if (slice.capacityPredecessorIds.length === 0) {
        throw new GanttDataError(
          `slice ${slice.id} is floored by a team's capacity but nothing was holding the pool`,
        );
      }
      // `null` here is `none` alone — the label the pool was keyed on is gone
      // from a payload that could only have been floored on one, which is the
      // wire having lost half of what it sent. The other nameless state,
      // `unresolved`, is a skew that heals and {@link poolNameOf} gives it
      // words instead.
      //
      // Proof: this throw replaced by `poolNameOf(team) ?? 'its team'`, `throws
      // when a capacity-floored row names no team to be short of` alone failed,
      // on `expected function to throw an error, but it didn't` — a sentence
      // about a pool the chart cannot name, over a bar whose whole explanation
      // is whose people it is short of. Watched 2026-08-13.
      const poolName = poolNameOf(team);
      if (poolName === null) {
        throw new GanttDataError(
          `slice ${slice.id} is floored by a team's capacity but its row names no team`,
        );
      }
      return capacityFloorWords(
        poolName,
        slice.width,
        predecessor,
        slice.capacityPredecessorIds.length - 1,
        rowNames,
        rolesById,
      );
    }
    case 'person': {
      // Proof: this throw replaced by `return 'Waits for a person'`, `throws
      // when a person floor names no resource predecessor` failed; watched
      // 2026-08-09.
      if (predecessor === undefined) {
        throw new GanttDataError(
          `slice ${slice.id} is floored by a person but names no resource predecessor`,
        );
      }
      // Proof: this throw replaced by `personFloorWords(personName ?? 'somebody', …)`.
      // `throws when a person floor names nobody at all` alone failed, on `expected
      // function to throw an error, but it didn't`; watched 2026-08-09.
      if (personName === null) {
        throw new GanttDataError(
          `slice ${slice.id} is floored by a person but names no person at all`,
        );
      }
      return personFloorWords(personName, predecessor, rowNames, rolesById);
    }
    default: {
      // `never` here is the type saying the six above are all of them; the
      // throw is for the runtime, where a payload can carry a seventh.
      //
      // Proof: this `default` replaced by
      // `return FLOOR_SENTENCE[slice.boundBy as Exclude<BindingFloor, 'person'>]`
      // — what the code did before. `throws rather than saying nothing at all
      // about what holds a bar` alone failed, on `expected function to throw an
      // error, but it didn't`. What it drew instead, printed in the same run:
      // `floorWords` `undefined`, and a hover title of `"Strip\nDev ·
      // Unassigned\nWorkdays 0 → 3 · 3 days\nFloat 0 days\n"` — the line the
      // panel exists to show, gone, and a bare newline where it was. Watched
      // 2026-08-09.
      const unknownFloor: never = slice.boundBy;
      throw new GanttDataError(
        `slice ${slice.id} is held by ${String(unknownFloor)}, which this chart has no words for`,
      );
    }
  }
}

/**
 * What holds each row's **start**, in the same words the chart's bars use — for
 * the table, which has never asked.
 *
 * The table shows a `Start` figure and no reason for it, and the commonest
 * reading of a plan is somebody deciding the tool is broken: a row starting
 * four days before the `End` of the thing it waits for is
 * `dep-waits-on-first-role` working correctly, and nothing on that line says
 * so. Every fact needed to say it has been on the wire since `boundBy` was
 * added; this is the seam, not new prose. {@link floorWordsOf} is the one
 * vocabulary, so a reader moving between the chart's hover and the table's
 * hover reads the same sentence about the same row rather than two accounts of
 * one wait.
 *
 * **The row's floor is its earliest slice's**, and that is the only judgement
 * here. A row's `earliestStart` is the least of its slices' — be-01 computes it
 * that way — so the slice that starts when the row does is the one whose floor
 * is the row's, and a tie goes to role order because that is the order the row
 * is read in. A row's *later* roles are held by `roleOrder`, which is the row
 * waiting on itself and answers nothing.
 *
 * **Total, and that is the difference from {@link layOutGantt}.** The chart
 * refuses a malformed payload whole, behind an error boundary that says why;
 * the table cannot, because forty columns of real data would go with it. So a
 * row this cannot explain is simply absent from the map and its cell says
 * exactly what it said before this existed — and the chart, on the same
 * payload, still refuses out loud. Silence here is never silence everywhere.
 *
 * Parents are skipped: a parent holds no slices, its span is a projection of
 * what is underneath, and nothing floors it.
 */
export function startFloorByRow(
  plan: GanttPlan,
  calendar: FloorCalendar | null,
): ReadonlyMap<string, string> {
  const rowNames = new Map(plan.rows.map((row) => [row.id, spokenNameOf(row)]));
  const sliceById = new Map(plan.slices.map((slice) => [slice.id, slice]));
  const rolesById: ReadonlyMap<string, GanttRolePlace> = new Map(
    plan.roles.map((role, place) => [role.id, { place, name: role.name }]),
  );
  const slicesByWorkItem = new Map<string, GanttSlice[]>();
  for (const slice of plan.slices) {
    const own = slicesByWorkItem.get(slice.workItemId);
    if (own === undefined) slicesByWorkItem.set(slice.workItemId, [slice]);
    else own.push(slice);
  }

  const leavesUnder = leavesUnderOf(plan.tree);
  const predecessorsOf = new Map<string, string[]>();
  for (const edge of plan.dependencies) {
    const own = predecessorsOf.get(edge.successorId);
    if (own === undefined) predecessorsOf.set(edge.successorId, [edge.predecessorId]);
    else own.push(edge.predecessorId);
  }

  /**
   * The calendar day a workday offset lands on, or null on a plan with no
   * calendar to say it on.
   *
   * Built once and refused once. `addWorkdays` and `shortIsoDate` each throw on
   * a start date that is not a calendar day, and a plan carrying one would
   * otherwise throw on **every** row here — past the `GanttDataError` catch
   * below, which is narrow on purpose — and take the whole table with it. One
   * probe at the origin turns that into the state this function already models:
   * a wait named with no day beside it. `clearsOnOf` and `startsOnOf` both read
   * their day through it, so the anchor's last day and the successor's own
   * start day are one arithmetic and the same-day comparison is like for like.
   */
  const dayOf = ((): ((workdayOffset: number) => string | null) => {
    if (calendar === null) return () => null;
    try {
      shortIsoDate(addWorkdays(calendar.startDate, 0), calendar.today);
    } catch {
      return () => null;
    }
    return (workdayOffset) =>
      shortIsoDate(addWorkdays(calendar.startDate, workdayOffset), calendar.today);
  })();

  const clearsOnOf = (anchor: GanttSlice): string | null =>
    dayOf(lastWorkdayOf(anchor.earliestStart, anchor.earliestFinish));

  const startsOnOf = (slice: GanttSlice): string | null =>
    dayOf(firstWorkdayOf(slice.earliestStart));

  const words = new Map<string, string>();
  for (const row of plan.rows) {
    if (!row.leaf) continue;
    const own = inRoleOrderSafely(slicesByWorkItem.get(row.id) ?? [], rolesById);
    if (own === null || own.length === 0) continue;
    // `<` and not `<=`, so a tie keeps the first in role order rather than the
    // last: two slices starting together are Dev and QA both standing on the
    // project's first day, and the row is read Dev-first.
    let anchor = own[0];
    for (const each of own) {
      if (each.slice.earliestStart < anchor.slice.earliestStart) anchor = each;
    }
    try {
      // Which stored dependency is the one holding this row: the latest-
      // finishing anchor among its predecessors, which is the floor be-01 took
      // when it wrote `boundBy: 'predecessor'`. Resolved only for that floor —
      // a row held by a person, a pool or its own earlier role has a sentence
      // that names something else, and walking every edge to say nothing is a
      // walk per row of every plan.
      const dependencyAnchor =
        anchor.slice.boundBy !== 'predecessor'
          ? undefined
          : latestAnchorAmong(
              predecessorsOf.get(row.id) ?? [],
              leavesUnder,
              slicesByWorkItem,
              rolesById,
              row.id,
            );
      words.set(
        row.id,
        floorWordsOf(
          anchor.slice,
          anchor.slice.resourcePredecessorId === null
            ? undefined
            : sliceById.get(anchor.slice.resourcePredecessorId),
          personNameOf(anchor.slice, plan.personNames),
          row.team,
          row.notBeforeReason ?? null,
          rowNames,
          rolesById,
          dependencyAnchor,
          dependencyAnchor === undefined ? null : clearsOnOf(dependencyAnchor.slice),
          startsOnOf(anchor.slice),
        ),
      );
    } catch (error) {
      // The narrow catch is the point: `GanttDataError` is this module saying a
      // payload broke a promise, and skipping the row is the table's answer to
      // exactly that. Anything else thrown out of here is a fault in this
      // function, and swallowing it would leave a column quietly blank on every
      // row of every plan with nothing anywhere to read.
      if (!(error instanceof GanttDataError)) throw error;
    }
  }
  return words;
}

/**
 * {@link inRoleOrder}, or null where the payload puts a slice under a role the
 * plan does not list.
 *
 * The throw is right for the chart and wrong here for {@link startFloorByRow}'s
 * reason, and it is caught around the sort rather than around the whole row
 * because the sort is not inside the `try` below it: `inRoleOrder` resolves
 * every place *before* comparing, so the throw fires while the list is being
 * built and not while the sentence is being written.
 */
/**
 * The plan's calendar, for the surfaces that say a floor's date in words.
 *
 * `today` rides along because {@link shortIsoDate} drops the year only when it
 * matches the reader's own — the omission is never ambiguous, and a module that
 * reached for a clock of its own would make one sentence on the page unpinnable
 * in a test.
 */
export interface FloorCalendar {
  /** The plan's start date, as be-01 holds it; the origin every offset counts from. */
  startDate: IsoDate;
  /** The reader's own today, which is the year {@link shortIsoDate} measures its omission against. */
  today: Date;
}

/**
 * The latest-finishing anchor among a row's stored predecessors, or `undefined`
 * where it has none the payload can name.
 *
 * That is be-01's own floor: a `predecessor`-bound slice stands on the last of
 * its dependencies' anchors to finish, so the one this picks is the one whose
 * date the row is actually waiting on. A tie keeps the first stored, which is
 * the order the deps cell lists them in.
 *
 * **One unresolvable predecessor gives up the whole naming**, and that is the
 * only real judgement here. `anchorSliceOf` throws when a leaf has no slice in
 * the payload *at all* — a collapsed branch keeps its slices, so this is
 * malformed data rather than a hidden row — and the one it could not read may
 * be the one that finishes last. Naming the latest of the rest would then print
 * a confident sentence about the wrong dependency, which is worse than the
 * general sentence this row read yesterday. So the row keeps that instead.
 */
function latestAnchorAmong(
  predecessorIds: readonly string[],
  leavesUnder: ReadonlyMap<string, string[]>,
  slicesByWorkItem: ReadonlyMap<string, GanttSlice[]>,
  rolesById: ReadonlyMap<string, GanttRolePlace>,
  successorId: string,
): PlacedSlice | undefined {
  let latest: PlacedSlice | undefined;
  for (const predecessorId of predecessorIds) {
    let anchor: PlacedSlice;
    try {
      anchor = anchorSliceOf(
        predecessorId,
        leavesUnder,
        slicesByWorkItem,
        rolesById,
        (leafId) =>
          `dependency ${predecessorId} → ${successorId}: ${leafId} has no slice in this ` +
          `payload, so the wait has no anchor to name`,
      );
    } catch (error) {
      if (!(error instanceof GanttDataError)) throw error;
      return undefined;
    }
    if (latest === undefined || anchor.slice.earliestFinish > latest.slice.earliestFinish) {
      latest = anchor;
    }
  }
  return latest;
}

/**
 * The leaves beneath every work item of the **full** tree — a leaf maps to
 * itself.
 *
 * The tree and not the shown rows, because the anchor of a collapsed
 * predecessor branch lives on leaves `plan.rows` has dropped.
 *
 * Module-level since `row-floor-names-the-dep`: {@link startFloorByRow} needs
 * the same walk {@link layOutGantt} does, and a second copy of it is a second
 * answer to "which slice does this edge leave from" — the exact fault the
 * `dep-waits-on-first-role` rule was written once to prevent.
 */
function leavesUnderOf(tree: readonly GanttTreeRow[]): ReadonlyMap<string, string[]> {
  const childrenOf = new Map<string, GanttTreeRow[]>();
  for (const treeRow of tree) {
    if (treeRow.parentId === null) continue;
    const group = childrenOf.get(treeRow.parentId);
    if (group === undefined) childrenOf.set(treeRow.parentId, [treeRow]);
    else group.push(treeRow);
  }
  const found = new Map<string, string[]>();
  const walk = (id: string): string[] => {
    const already = found.get(id);
    if (already !== undefined) return already;
    const children = childrenOf.get(id);
    const leaves = children === undefined ? [id] : children.flatMap((child) => walk(child.id));
    found.set(id, leaves);
    return leaves;
  };
  for (const treeRow of tree) walk(treeRow.id);
  return found;
}

/**
 * The slice a dependency on `predecessorId` actually waits for: a leaf's first
 * slice in role order **that somebody estimated**, its last slice when nobody
 * estimated any of them, and for a parent the latest-finishing anchor among its
 * leaves (design.md D6).
 *
 * Selected from the payload and never recomputed from estimates: the walk is
 * be-01's, read off the `estimated` flag the wire carries, so the slice named
 * here is the slice the engine joined the edge to.
 *
 * The whole {@link PlacedSlice} rather than its span, which is the difference
 * from what {@link layOutGantt} used to keep privately: an arrow needs two
 * numbers, and a sentence naming the wait needs the work item and the role.
 *
 * `saying` is the caller's own wording for the failure, since the same walk
 * serves an arrow with no anchor to leave from and a row with no wait to name.
 *
 * @throws GanttDataError when a leaf under the predecessor has no slice in the
 * payload at all. be-01 emits at least one slice per leaf, so that is a broken
 * promise rather than a hidden row — and a link silently dropped would hide
 * exactly the wait these surfaces exist to show.
 */
function anchorSliceOf(
  predecessorId: string,
  leavesUnder: ReadonlyMap<string, string[]>,
  slicesByWorkItem: ReadonlyMap<string, GanttSlice[]>,
  rolesById: ReadonlyMap<string, GanttRolePlace>,
  saying: (leafId: string) => string,
): PlacedSlice {
  const leafIds = leavesUnder.get(predecessorId) ?? [predecessorId];
  const anchors = leafIds.map((leafId) => {
    const own = inRoleOrder(slicesByWorkItem.get(leafId) ?? [], rolesById);
    const anchor = own.find((each) => each.slice.estimated) ?? own.at(-1);
    if (anchor === undefined) throw new GanttDataError(saying(leafId));
    return anchor;
  });
  // Never empty, so the pick below has a seed: the walk maps a childless id
  // to itself, a parent to its children's leaves, and the `??` arm is one id.
  let latest = anchors[0];
  for (const anchor of anchors) {
    if (anchor.slice.earliestFinish > latest.slice.earliestFinish) latest = anchor;
  }
  return latest;
}

function inRoleOrderSafely(
  slices: readonly GanttSlice[],
  rolesById: ReadonlyMap<string, GanttRolePlace>,
): PlacedSlice[] | null {
  try {
    return inRoleOrder(slices, rolesById);
  } catch (error) {
    if (!(error instanceof GanttDataError)) throw error;
    return null;
  }
}
