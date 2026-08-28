import { snapWorkdays } from '@wbs/domain';

import type { WorkItem } from '../repository';
import { deriveNumbers } from './derive-numbers';

/** A finish-to-start edge, as written: either end may be a parent. */
export interface DependencyEdge {
  predecessorId: string;
  successorId: string;
}

/**
 * One work item's work for one role — the unit a schedule is computed in.
 *
 * `roleId` is null only in a project that holds no roles at all, which is
 * reachable: a project's last role can be removed. The work item still has to
 * be somewhere in the plan, so it gets one slice belonging to nobody rather
 * than falling out of the graph its neighbours' dependencies run through.
 *
 * `days` is **effort**, not duration: a slice of 6 days' effort that three
 * people may work at once runs for 2. Duration is `days / width`, and the two
 * are the same number for every slice of width 1 — which is every slice of
 * every plan that sets neither capacity field.
 *
 * `days` is null when nobody has estimated this pair, which is not the same
 * fact as zero — see {@link Scheduled.estimated}.
 */
export interface Slice {
  workItemId: string;
  roleId: string | null;
  days: number | null;
  /**
   * Who is doing this work, or nobody — **resolved by the caller**.
   *
   * A work item with exactly one assignment is taken to be that person's
   * whole — the assumed assignee — so every slice of it carries them, and a
   * work item with two carries each role's own. The reading is
   * `assumedAssignee`, and it is made here rather than in the pass because a
   * second implementation of it would put people in queues nobody assigned
   * them to. The pass only ever asks "the same person as that slice?".
   */
  personId: string | null;
  /**
   * How many slots this block holds at once — 1 unless the plan says
   * otherwise, and **resolved by the caller**.
   *
   * `personId`'s rule for `personId`'s reason: a second implementation of the
   * clamp inside the pass would put work on widths nobody asked for. The
   * caller's reading is the item's `maxParallel`, clamped down by its pool's
   * size and dropped to 1 for a named assignee — one human cannot work beside
   * themselves.
   *
   * The block is **indivisible**: `width` slots for `days / width` days, or it
   * waits. It never runs narrow and widens later, because a duration that
   * depended on what was free when the block was popped would depend on
   * placement order, and `offsets[]` is summed before any of that is known.
   */
  width: number;
  /**
   * The pools this block draws its slots from — one per **sized** team the row
   * is effectively labelled with, from `effectiveTeamsOf`, and **resolved by
   * the caller** for `width`'s reason.
   *
   * **Every member spends the block's whole width for the block's whole
   * duration** (Dany, 2026-08-13): three teams on a five-day slice block five
   * days in each of the three pools, not five days split between them. So the
   * block starts at the earliest instant *all* of them have room, and takes a
   * slot from each.
   *
   * Empty is the state of every plan that names no team and of every plan whose
   * teams are unsized: an empty set reserves nothing and waits for nothing,
   * which is the `null` this replaced, verbatim.
   *
   * Deliberately not `string | null` widened to an array of at most one: the
   * shape changed so that every reader of the old field is a compile error
   * rather than a silent first-member read (`team-sets` design.md D3/D4, one
   * layer down).
   */
  poolIds: readonly string[];
}

/**
 * How many slots each pool holds — the sizes the placement is bounded by.
 *
 * A separate argument rather than a field on the slice, because the bound is a
 * fact about the **team** and every slice on one pool must read one number:
 * carried per slice, two slices could disagree about the size of the pool they
 * share and the profile would have no answer to give.
 *
 * A pool id this map has no entry for is a caller fault and the pass throws:
 * the caller only ever puts a team in `poolIds` when it **has** a size, so an
 * absent entry means the two readings came apart. R5 — a default of `Infinity`
 * here would be a pool constraint silently not applied.
 */
export type PoolSizes = ReadonlyMap<string, number>;

/**
 * The key one slice is held under. Opaque: read {@link ScheduledSlice}'s own
 * `workItemId` and `roleId` rather than taking this apart.
 *
 * Separated by a NUL, which no id can contain, so no two pairs can collide by
 * running into each other. Written as an escape rather than typed: a literal
 * NUL in a source file makes git call the file binary.
 */
export function sliceKey(workItemId: string, roleId: string | null): string {
  return `${workItemId}\u0000${roleId ?? ''}`;
}

/**
 * When a work item can happen, in whole days from the project's day zero.
 *
 * `duration` is a leaf's own expected days and is 0 for a parent — a parent has
 * no work of its own, it has a span. `estimated` is what stops that zero being
 * read as "instant" when it means "nobody has looked".
 */
export interface Scheduled {
  duration: number;
  estimated: boolean;
  earliestStart: number;
  earliestFinish: number;
  latestStart: number;
  latestFinish: number;
  float: number;
  critical: boolean;
}

/**
 * What decided a slice's start: the latest of its floors, named.
 *
 * `projectStart` means nothing did — it starts on day zero. `predecessor` is a
 * dependency onto another work item, `roleOrder` the work item's own earlier
 * role, `notBefore` a manual date, `person` the assignee finishing something
 * else, and `capacity` the team having no free slot wide enough for the whole
 * of this block.
 *
 * A tie is **not** the later kind in this list: when the assignee comes free
 * exactly as the dependency clears, nobody is waiting for them, and a plan
 * that said otherwise would count that row into "N tasks wait for a person".
 * Each kind therefore means its floor was strictly the latest of them.
 *
 * `capacity` sits after `person` because a slice can now carry both — the work
 * item's team spends a slot whether or not somebody is named on the work — so
 * the order decides a real case rather than a hypothetical one: kat free on
 * day 4 with a slot opening on day 6 says capacity, and both landing on day 6
 * says person.
 */
export type ScheduleFloor =
  | 'projectStart'
  | 'predecessor'
  | 'roleOrder'
  | 'notBefore'
  | 'person'
  | 'capacity';

/** One slice's schedule, carrying what it is the schedule of and what held it there. */
export interface ScheduledSlice extends Scheduled {
  workItemId: string;
  roleId: string | null;
  /** The person this work is queued behind, as the caller resolved it. */
  personId: string | null;
  boundBy: ScheduleFloor;
  /**
   * The slice this one waited behind, or null — the **display referent**, not
   * the graph.
   *
   * For a `person` floor it is the slice the assignee was busy with. For a
   * `capacity` floor it is one of {@link capacityPredecessorIds}: the latest
   * finisher of the blocking set, ties broken by placement order. The graph
   * carries the whole set; a chart draws one arrow, and the hover says "and N
   * others" when the set is larger.
   *
   * Set only when `boundBy` is `person` or `capacity` — an arrow drawn for a
   * resource edge that did not bind would claim a wait that is not there. It is
   * a key into {@link Schedule.slices}: look it up rather than taking it apart,
   * exactly as {@link sliceKey} says.
   */
  resourcePredecessorId: string | null;
  /**
   * Every reservation that had to end for this block to fit — the **whole**
   * blocking set, as keys into {@link Schedule.slices}.
   *
   * Empty for every slice a pool did not hold up. Non-empty exactly when
   * `boundBy` is `capacity`, which is an invariant the render path relies on
   * and `floorWordsOf` refuses to work around.
   *
   * The set rather than one edge, because one edge reports float that is not
   * there. Pool of 2, width-1 blocks A and B ending on days 5 and 7, width-2
   * block X therefore starting on day 7: with only B→X in the graph, A appears
   * free to slip for ever — and A ending on day 8 pushes X and the project with
   * it. That is a row reported as having slack it has none of, which is the
   * class of fault that killed the first leveling algorithm.
   *
   * **The error is one-sided by construction.** "At least one of these must
   * move" is a disjunction, and a DAG cannot express one, so edging all of them
   * makes the graph at least as tight as reality: float can come out *smaller*
   * than it truly is, never larger. No row is ever reported movable when it is
   * not.
   */
  capacityPredecessorIds: string[];
  /**
   * Which pool ran out — the team whose slots this slice waited for, or null.
   *
   * Set exactly when `boundBy` is `capacity`, and null on every other slice:
   * the same invariant shape as {@link capacityPredecessorIds}, and the render
   * path relies on both together.
   *
   * **Named here rather than read off the row's labels**, because a row may
   * carry several teams and the binding one is not the first of them by any
   * ordering the chart knows. A sentence naming the wrong team is worse than no
   * sentence — it explains a date with a name that had room.
   *
   * Where two pools both pin the final start, this is the one whose blocking
   * set holds the latest finisher, ties by pool id — the display referent's own
   * rule, one level up, so the team named and the slice pointed at are answers
   * to the same question. The rest of the tie is the chart's to say ("and N
   * other teams"), and the whole set is not carried: the reader is owed the
   * blocking *slices*, which {@link capacityPredecessorIds} already holds.
   */
  capacityTeamId: string | null;
  /**
   * How many slots this slice held while it ran — the caller's
   * {@link Slice.width}, carried out so a reader can see why the duration is
   * what it is.
   */
  width: number;
  /**
   * The work itself, in days, before it was divided among {@link width}
   * people.
   *
   * `duration` is what the block occupied — `effort / width` — and the two are
   * the same number at width 1, which is every slice of every plan that sets
   * neither capacity field.
   */
  effort: number;
}

/**
 * A plan, in the unit it is computed in and in the unit it is read in.
 *
 * `slices` is the engine's own output; `workItems` is the projection of it, and
 * is what the table reads. The Gantt is what will read the slices — one bar
 * each, and the person links drawn from `resourcePredecessorId`.
 */
export interface Schedule {
  slices: Map<string, ScheduledSlice>;
  workItems: Map<string, Scheduled>;
  /**
   * How many work items hold a slice a **person** is the reason for.
   *
   * Counted per work item rather than per slice, because that is the sentence
   * the schedule header says: "N tasks wait for a person". Zero on every plan
   * with nobody assigned, which is the state this tool shipped in until now.
   */
  waitingForPerson: number;
  /**
   * How many work items hold a slice a **team's capacity** is the reason for.
   *
   * Counted per work item exactly as {@link waitingForPerson} is, and beside it
   * rather than folded into it: "waiting for a person" and "waiting for a slot"
   * are different sentences and a planner acts on them differently — one is
   * somebody's calendar, the other is a headcount. Zero on every plan with no
   * team sized, which is the state this tool shipped in until now.
   */
  waitingForCapacity: number;
  /**
   * How many aggregated pool events the levelling pass's window searches
   * visited, together.
   *
   * Instrumentation rather than an answer, and it is on the return type
   * because the alternative is a wall-clock assertion: a millisecond figure is
   * not an R5 proof and is flaky in CI, while this counts the work the stated
   * complexity is a claim about. `schedule-capacity.test.ts` asserts it against
   * a bound derived from that complexity, and it is the reason the missing
   * `W <= N` clamp fails as a bounded number rather than as a hang.
   * `verify.md` records the wall-clock figures, where an observation belongs.
   */
  eventsVisited: number;
}

/** The cycle a graph cannot be ordered around. Typed so callers catch this and nothing else. */
export class ScheduleCycleError extends Error {
  override name = 'ScheduleCycleError' as const;
  constructor() {
    super('dependency cycle: the schedule cannot be ordered');
  }
}

/**
 * The tree, indexed once: children by parent, and the leaves beneath every id.
 *
 * Built in one pass and shared by everything that needs it. The first version
 * rebuilt the child index inside a helper called twice per edge and once per
 * parent, which is quadratic in the rows before the edges are even expanded.
 */
export interface TreeIndex {
  /** Every work item with no children — the only things with a duration. */
  leafIds: string[];
  /** For any id: the leaves beneath it. A leaf maps to itself. */
  leavesUnder: Map<string, string[]>;
}

export function indexTree(rows: readonly WorkItem[]): TreeIndex {
  const childrenOf = new Map<string, WorkItem[]>();
  for (const row of rows) {
    if (row.parentId === null) continue;
    const group = childrenOf.get(row.parentId);
    if (group === undefined) childrenOf.set(row.parentId, [row]);
    else group.push(row);
  }

  const leavesUnder = new Map<string, string[]>();
  const walk = (id: string): string[] => {
    const already = leavesUnder.get(id);
    if (already !== undefined) return already;
    const children = childrenOf.get(id);
    const found = children === undefined ? [id] : children.flatMap((child) => walk(child.id));
    leavesUnder.set(id, found);
    return found;
  };
  for (const row of rows) walk(row.id);

  return {
    leafIds: rows.filter((row) => !childrenOf.has(row.id)).map((row) => row.id),
    leavesUnder,
  };
}

/**
 * The edges as the schedule sees them: every pair of leaves the written edges
 * imply.
 *
 * Exported because `canDepend` must ask its question of **this** graph. Asking
 * it of the written edges instead let through an edge whose expansion closed a
 * cycle — the API accepted it, and every later read of the project threw. Two
 * reviewers found that independently, with different examples.
 */
export function expandToLeaves(
  index: TreeIndex,
  edges: readonly DependencyEdge[],
): DependencyEdge[] {
  const isLeaf = new Set(index.leafIds);
  const expanded: DependencyEdge[] = [];
  for (const { predecessorId, successorId } of edges) {
    for (const from of index.leavesUnder.get(predecessorId) ?? []) {
      if (!isLeaf.has(from)) continue;
      for (const to of index.leavesUnder.get(successorId) ?? []) {
        if (isLeaf.has(to)) expanded.push({ predecessorId: from, successorId: to });
      }
    }
  }
  return expanded;
}

/** Whether the leaf graph can be ordered at all — the same question the sort asks. */
export function hasCycle(index: TreeIndex, edges: readonly DependencyEdge[]): boolean {
  try {
    topological(index.leafIds, expandToLeaves(index, edges));
    return false;
  } catch {
    return true;
  }
}

/**
 * Kahn's algorithm over the leaf graph, throwing on a cycle — the question
 * {@link hasCycle} asks before an edge is written.
 *
 * The pass below asks the same question of the slice graph and answers it the
 * same way, from its own eligible set: a plan whose slices cannot all be
 * placed is a plan with a loop in it.
 *
 * The throw is not redundant with the write path's refusal. That guard protects
 * the edges this application creates; this protects the computation from any
 * graph it is handed — a restored database, a future bulk import — because a
 * schedule computed from a cycle is wrong in a way no reader could detect.
 */
function topological(
  leafIds: readonly string[],
  edges: readonly { predecessorId: string; successorId: string }[],
): string[] {
  const incoming = new Map(leafIds.map((id) => [id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const { predecessorId, successorId } of edges) {
    const group = outgoing.get(predecessorId);
    if (group === undefined) outgoing.set(predecessorId, [successorId]);
    else group.push(successorId);
    incoming.set(successorId, (incoming.get(successorId) ?? 0) + 1);
  }

  const ready = leafIds.filter((id) => incoming.get(id) === 0);
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift();
    if (id === undefined) break;
    order.push(id);
    for (const next of outgoing.get(id) ?? []) {
      const left = (incoming.get(next) ?? 0) - 1;
      incoming.set(next, left);
      if (left === 0) ready.push(next);
    }
  }

  // Proof: this throw deleted and six `canDepend` tests failed, among them
  // `refuses an edge that closes a cycle` and `refuses an edge whose expansion
  // closes a cycle through a parent` — the write path accepted every loop it
  // exists to refuse; watched 2026-08-09.
  if (order.length !== leafIds.length) throw new ScheduleCycleError();
  return order;
}

/**
 * One leaf's slices in role order, and the running offsets that place them
 * inside its span.
 *
 * `offsets[i]` is how far slice `i` starts after the work item itself does, and
 * `offsets[length]` is the work item's whole duration. Held rather than
 * recomputed because those two facts are what keep the arithmetic exact — see
 * {@link schedule}.
 */
interface WorkItemSlices {
  slices: readonly Slice[];
  offsets: readonly number[];
}

/**
 * The slices grouped by the leaf they belong to, in the order they were handed
 * over — which is the project's role order, and therefore the order they run in.
 *
 * Throws on a slice for something that is not a leaf of `rows`. A parent has no
 * work of its own and a work item from another project has no place in this
 * graph at all; scheduling either would be answering a question about a plan
 * that was not asked for. R5: this is malformed input, not a missing default.
 *
 * Proof: with the check removed, `refuses a slice for a work item that is not a
 * leaf` gets a schedule back in which the parent has become a node of its own
 * and its span no longer covers its children; watched 2026-08-09.
 */
function groupByWorkItem(
  leafIds: readonly string[],
  slices: readonly Slice[],
): Map<string, WorkItemSlices> {
  const leaves = new Set(leafIds);
  const grouped = new Map<string, Slice[]>();
  for (const slice of slices) {
    if (!leaves.has(slice.workItemId)) {
      throw new Error(`slice for ${slice.workItemId}, which is not a leaf of this project`);
    }
    // A width is people, and the smallest number of people that can do work is
    // one. Refused **here**, at the boundary the slices enter the engine
    // through, because `durationOf` divides by it: a width of 0 is `Infinity`
    // days for a slice with effort and `NaN` for one without, and neither is
    // refused anywhere downstream — `windowFor` short-circuits on a zero width
    // and reserves nothing, `CapacityTooNarrowError` does not fire because
    // `0 > 0` is false, and the plan comes back with every date `Infinity` and
    // nothing to say why. R5: malformed trusted data throws rather than being
    // divided by.
    //
    // Unreachable through the API as of this change — both write paths refuse a
    // 0 — which is exactly why it is here rather than nowhere: this engine
    // refuses the impossible at its own boundary, and a validation that is the
    // *only* guard is one schema edit away from not being one. Named as the
    // open P2 of PR #48's cross-review.
    //
    // Proof: this check deleted and `refuses a slice claiming no people at all`
    // failed — the plan came back with `duration: Infinity`,
    // `earliestFinish: Infinity`, `latestStart: NaN` and `float: NaN`, and no
    // refusal anywhere. Deleted again for `refuses a width that is not a whole
    // number of people`, which came back with `duration: 2.4` — six days over
    // two and a half people. Both watched 2026-08-12.
    if (!Number.isInteger(slice.width) || slice.width < 1) {
      throw new Error(
        `slice for ${slice.workItemId} claims a width of ${String(slice.width)}: ` +
          `a width is people, and duration is effort divided by it`,
      );
    }
    const group = grouped.get(slice.workItemId);
    if (group === undefined) grouped.set(slice.workItemId, [slice]);
    else group.push(slice);
  }

  const sliced = new Map<string, WorkItemSlices>();
  for (const [workItemId, group] of grouped) {
    const offsets = [0];
    for (const slice of group) offsets.push(offsets[offsets.length - 1] + durationOf(slice));
    sliced.set(workItemId, { slices: group, offsets });
  }
  return sliced;
}

/**
 * How long a slice occupies the calendar: its effort divided among the people
 * working on it at once.
 *
 * **`E / 1 === E` exactly**, for every value that can reach {@link Slice.days}.
 * That is the whole of this change's identity claim and it is narrower than
 * "for all doubles": `days` arrives only through `finalDays()` over a validated
 * `ThreePointEstimate`, whose three fields are `number>=0` — finite and
 * non-negative — or through `null`. Division by one is exact in IEEE-754 for
 * every finite value, `-0 / 1 === -0`, and the prefix sum's `0 + -0` already
 * normalises to `+0` on both sides of this change. So `offsets[]` is the same
 * array of the same doubles for every plan that sets no capacity field, and the
 * differential is the proof rather than this paragraph.
 *
 * The boundary that makes the claim true is asserted separately: a non-finite
 * estimate cannot reach `Slice.days` (`estimate.test.ts`).
 *
 * Proof: the division dropped, so duration is effort again, and `compresses six
 * days of effort into two when three may work at once` failed with a duration
 * of 6 where 2 was owed; watched 2026-08-12.
 */
function durationOf(slice: Slice): number {
  return (slice.days ?? 0) / slice.width;
}

/**
 * One slice as the passes see it: what it is, where it sits, and what the
 * **plan** says it waits for.
 *
 * The node is the unit of the graph and its index in {@link SliceGraph.nodes}
 * is its name there — every edge, order and result below is an index into the
 * same array. That is not a micro-optimisation: keyed by string, each of those
 * reads is a lookup that can miss, and a schedule made of maps grows a fence of
 * "this cannot happen" throws whose failure nobody has ever seen. An index into
 * an array the pass built cannot miss, and the type says so.
 *
 * The resource edges are not here, because they do not exist until the
 * placement chooses them.
 */
interface SliceNode {
  key: string;
  slice: Slice;
  /** Which work item's span it belongs to, as an index into the pass's own arrays. */
  item: number;
  /** How many roles into that work item it is. */
  at: number;
  /** Its work item's running offsets — one shared array per work item. */
  offsets: readonly number[];
  /** The earliest day its work item may start; only its first slice carries one. */
  notBefore: number;
  predecessors: number[];
  successors: number[];
}

/** The plan as the passes run over it. */
interface SliceGraph {
  nodes: readonly SliceNode[];
  /** How many work items the nodes belong to — the width of the anchor arrays. */
  items: number;
}

/**
 * No node — what a slice with nobody in front of it carries where a resource
 * predecessor would go.
 *
 * A sentinel rather than `null` because the field is read on every slice of
 * every plan and the union would be one narrowing per read for a case the
 * placement already knows the answer to. -1 is not an index any array has.
 */
const NOBODY = -1;

/** Where one slice was put, and what put it there. */
interface Placed {
  start: number;
  finish: number;
  boundBy: ScheduleFloor;
  /**
   * The node it waited behind, or -1 when nobody held it up — the display
   * referent for both resource kinds. See
   * {@link ScheduledSlice.resourcePredecessorId}.
   */
  resourcePredecessor: number;
  /**
   * Every reservation that had to end for this block to fit, as node indices.
   *
   * Empty unless a pool held the block up. The **whole** set, because one edge
   * reports float that is not there — see
   * {@link ScheduledSlice.capacityPredecessorIds}.
   */
  capacityPredecessors: number[];
  /** Which pool ran out — see {@link ScheduledSlice.capacityTeamId}. */
  capacityTeamId: string | null;
}

/**
 * One instant at which a pool's usage changes, with everything that changes at
 * it collected together.
 *
 * **Aggregated by timestamp, and that is not tidiness.** Reservations are
 * half-open `[start, finish)`, so at an instant where one block ends and
 * another begins the release must be seen before the acquisition; raw
 * `+W`/`-W` entries evaluated in insertion order can report a transient
 * over-capacity that never existed and push a block to a later window. Summing
 * every delta at one timestamp before the instant is evaluated is what makes
 * the answer independent of the order the entries arrived in, which is the
 * determinism claim.
 *
 * Proof: the merge in `eventAt` removed, so each reservation writes its own
 * entry, and `lets a block run through the instant another hands its slot over`
 * failed — the block came back at 4→8 instead of 0→4, pushed off a slot that
 * was never taken; watched 2026-08-12.
 */
interface PoolEvent {
  at: number;
  /** The net change in slots in use at this instant: acquisitions less releases. */
  delta: number;
  /** The nodes acquiring here, so the scan can keep an active set as it walks. */
  acquires: number[];
  /** The nodes releasing here, for the same reason. */
  releases: number[];
}

/**
 * A pool's usage over time, as the events that change it — plus how many slots
 * it has.
 *
 * The events are held sorted and aggregated; nothing else about the profile is
 * stored, because a reservation is written once and never moved and the usage
 * at any instant is therefore a function of them alone.
 */
interface Pool {
  size: number;
  events: PoolEvent[];
}

/**
 * A block wider than the pool it draws from, which no placement can satisfy.
 *
 * R5, and deliberately not a silent widening or an unbounded search: the width
 * is clamped to the pool's size by the caller (`widthFor` in
 * `work-item.service.ts`), so reaching this means the clamp and the sizes came
 * apart, and a scan that kept looking for a window would run past the last
 * event for ever. Bounded and named beats hanging.
 *
 * `where` names **which** of the two refusals fired, and it is not decoration.
 * The refusal below the window search is a backstop for the same property, and
 * with one message between them removing the up-front check left the negative
 * green — the backstop caught the same plan and said the same words. Watched
 * 2026-08-12: the two were one message, `refuses a block wider than the pool it
 * draws from` passed with the up-front check deleted, and the check was a claim
 * rather than a gate.
 */
class CapacityTooNarrowError extends Error {
  override name = 'CapacityTooNarrowError' as const;
  constructor(
    poolId: string,
    width: number,
    size: number,
    where: 'before the search' | 'past the last event',
  ) {
    super(
      `a block of width ${String(width)} cannot fit pool ${poolId}, which holds ` +
        `${String(size)}: the caller's clamp and the pool sizes disagree ` +
        `(refused ${where})`,
    );
  }
}

/**
 * The pools, the reservations on them, and the window search that places a
 * block against them.
 *
 * One object rather than free functions over a map, because the scan counter
 * below has to be a fact about **this** run: the instrumented perf bound
 * (`schedule-capacity.test.ts`) asserts how many aggregated events one plan
 * makes the placement visit, and a module-level counter would be a number about
 * whatever else the suite had run.
 */
function capacityProfile(sizes: PoolSizes) {
  const pools = new Map<string, Pool>();
  /**
   * How many aggregated events every window search has visited, together.
   *
   * The instrumented bound R5 asks for in place of a wall-clock assertion: a
   * wall-clock number is not a proof and is flaky in CI, while this counts the
   * work the stated complexity is a claim about.
   */
  let visited = 0;

  const poolFor = (poolId: string): Pool => {
    const already = pools.get(poolId);
    if (already !== undefined) return already;
    const size = sizes.get(poolId);
    // R5: the caller sets `poolId` only for a team that has a size, so an
    // absent entry means the adapter's reading and this map came apart. A
    // default here would be a capacity constraint quietly not applied.
    //
    // Proof: replaced with `?? Infinity` and `refuses a pooled slice whose pool
    // has no size` failed on `expected [Function] to throw` — the pool bounded
    // nothing and the plan came back unconstrained; watched 2026-08-12.
    if (size === undefined) throw new Error(`no size for pool ${poolId}`);
    const fresh: Pool = { size, events: [] };
    pools.set(poolId, fresh);
    return fresh;
  };

  /** Where `at` belongs in a pool's sorted events — the first entry not before it. */
  const indexOf = (events: readonly PoolEvent[], at: number): number => {
    let low = 0;
    let high = events.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (events[mid].at < at) low = mid + 1;
      else high = mid;
    }
    return low;
  };

  const eventAt = (pool: Pool, at: number): PoolEvent => {
    const index = indexOf(pool.events, at);
    if (index < pool.events.length && pool.events[index].at === at) return pool.events[index];
    const fresh: PoolEvent = { at, delta: 0, acquires: [], releases: [] };
    pool.events.splice(index, 0, fresh);
    return fresh;
  };

  // Named rather than returned anonymously so `jointWindowFor` can call
  // `windowFor` by name: the joint search is defined as a fixpoint over the
  // single-pool one, and `this` inside an object literal is a weaker way to say
  // that than the binding itself.
  const searches = {
    /**
     * The earliest instant at or after `floor` where `width` slots are free for
     * the **whole** of `duration`, and every reservation that had to end for
     * that to be true.
     *
     * One forward scan over the aggregated events, keeping the running usage
     * and the set of nodes currently holding slots. Where `usage + width` runs
     * past the pool, every active reservation goes into the blocking set and
     * the candidate window restarts at the next instant the aggregate changes —
     * no candidate between the current one and the violation can help, since
     * every one of them still contains it.
     *
     * **Whole-window, not the start instant.** A pool with a short gap followed
     * by a reservation overlapping the middle of the candidate duration must
     * not let the block take the gap.
     *
     * Proof: the interior walk disabled, so only the start instant is tested,
     * and `skips a gap it cannot fit inside and waits for the whole window`
     * failed — the block took the one-day hole and ran on top of the four-day
     * reservation behind it; watched 2026-08-12.
     *
     * **It terminates**, and the argument is immutable reservations rather than
     * chronology: every reservation is written once and never moved, so a
     * search reads a profile that cannot change under it, the candidate walks
     * strictly forward through a finite event list, and past the last event
     * usage is 0 — where `width <= size` always fits, which is what the throw
     * above guarantees.
     */
    windowFor(
      poolId: string | null,
      width: number,
      duration: number,
      floor: number,
    ): { start: number; blocking: number[] } {
      // Reserves nothing and waits for nothing: a slice of no length is not
      // work and a slice on no pool spends nobody's slots. The twin of the
      // existing person rule and of its watched proof.
      if (poolId === null || duration === 0 || width === 0) return { start: floor, blocking: [] };
      const pool = poolFor(poolId);
      // Refused here rather than found out at the end of the scan: this is the
      // statement that the caller's clamp and these sizes are one reading, and
      // it says so before any work is done. The backstop in `advancePast` holds
      // the same property from the other side; the two are told apart by the
      // clause they end with, because with one message between them this check
      // could be deleted and its negative stayed green.
      //
      // Proof: deleted, and `refuses a block wider than the pool it draws from`
      // failed on the message — the backstop caught the same plan and refused
      // `past the last event`, which is the same refusal arriving after a full
      // scan instead of before it; watched 2026-08-12.
      if (width > pool.size) {
        throw new CapacityTooNarrowError(poolId, width, pool.size, 'before the search');
      }

      const blocking = new Set<number>();
      const { events, size } = pool;
      let usage = 0;
      const active = new Set<number>();
      let at = 0;
      let start = floor;
      // Everything already over by the floor, folded in before the window is
      // considered at all — the profile does not begin at the floor.
      for (; at < events.length && events[at].at <= start; at += 1) {
        visited += 1;
        usage += events[at].delta;
        for (const node of events[at].acquires) active.add(node);
        for (const node of events[at].releases) active.delete(node);
      }

      /** Steps the scan past `instant`, then onto the next candidate start. */
      const advancePast = (instant: number): void => {
        for (; at < events.length && events[at].at <= instant; at += 1) {
          visited += 1;
          usage += events[at].delta;
          for (const node of events[at].acquires) active.add(node);
          for (const node of events[at].releases) active.delete(node);
        }
        // The backstop, and unreachable while the check above stands: past the
        // last event usage is 0, and `width <= size` therefore always fits, so
        // a scan can only run out of events when a block wider than its pool
        // got this far. Kept anyway, and bounded — a search that instead kept
        // looking would never come back — and told apart from the up-front
        // refusal by its clause so neither can stand in for the other.
        if (at >= events.length) {
          throw new CapacityTooNarrowError(poolId, width, size, 'past the last event');
        }
        const next = events[at];
        start = next.at;
        visited += 1;
        usage += next.delta;
        for (const node of next.acquires) active.add(node);
        for (const node of next.releases) active.delete(node);
        at += 1;
      };

      for (;;) {
        if (usage + width > size) {
          for (const node of active) blocking.add(node);
          // No candidate at or before this instant can work: every one of them
          // contains it. The next one is the next instant the aggregate moves.
          advancePast(start);
          continue;
        }
        // The interior of the candidate window, on a copy of the running state
        // so a violation leaves the scan where it can resume.
        let interior = at;
        let inside = usage;
        const held = new Set(active);
        let violatedAt: number | null = null;
        for (; interior < events.length && events[interior].at < start + duration; interior += 1) {
          visited += 1;
          inside += events[interior].delta;
          for (const node of events[interior].acquires) held.add(node);
          for (const node of events[interior].releases) held.delete(node);
          if (inside + width > size) {
            for (const node of held) blocking.add(node);
            violatedAt = events[interior].at;
            break;
          }
        }
        if (violatedAt === null) break;
        // Every candidate up to and including the violation contains it, so the
        // next one is the first instant after it.
        advancePast(violatedAt);
      }

      return { start, blocking: [...blocking] };
    },

    /**
     * The earliest instant at or after `floor` where **every** pool in the set
     * has `width` slots free for the whole of `duration` — the joint search.
     *
     * A fixpoint over {@link windowFor}, which is left byte-for-byte as it is:
     * every proof it carries — the interior walk, the aggregation, the two
     * refusals, the termination argument — is a statement about one pool, and
     * rewriting the tightest loop in the engine to say them about several is
     * the last thing this change should contain.
     *
     * ```
     * candidate = floor
     * loop: ask every pool for its window at candidate
     *       best = the latest of their answers
     *       if best === candidate: that is the answer
     *       candidate = best
     * ```
     *
     * **It terminates**, for `windowFor`'s reason plus one. Reservations are
     * immutable, so each pool's answer is a function of the candidate alone;
     * every round that does not finish moves the candidate **strictly** forward
     * onto an instant some pool's event list holds; the union of those lists is
     * finite; and past the last of them every pool is empty, where `width <=
     * size` always fits. A round that moves nothing is the answer by
     * definition.
     *
     * **The blocking set is accumulated across rounds, not taken from the last
     * one**, and that is not an optimisation — it is the whole set. At the
     * fixpoint every pool answers `candidate` *because it fits there*, so every
     * scan of the final round records nothing. What each round records is why
     * the block could not start where it was asked to, which is exactly the set
     * of reservations that had to end.
     *
     * `binding` is the pools whose own earliest fit is the final start — the
     * ones that ran out — carried with the blocking set of the round they
     * pushed in, so a caller can say which team the reader is waiting for. A
     * pool that pushed the candidate earlier and had room at the answer is not
     * binding: it is no longer the reason.
     *
     * **A set of one is `windowFor` itself**, and the short-circuit below says
     * so rather than leaving it to be inferred: a second round would ask a pool
     * for its window at its own answer, where the block provably fits for the
     * whole duration, and get the same instant back with an empty blocking set.
     * The saving is not the point — `eventsVisited` is a measured claim about
     * the work a placement does, and doubling it for every plan on the
     * deployment to re-derive an answer already in hand would be a real cost
     * paid for a uniformity nothing reads.
     */
    jointWindowFor(
      poolIds: readonly string[],
      width: number,
      duration: number,
      floor: number,
    ): {
      start: number;
      blocking: number[];
      binding: { poolId: string; blocking: number[] }[];
    } {
      // Spends nothing and waits for nothing — the `poolId === null` line,
      // under a set, and **only** that line: a zero duration and a zero width
      // are left to `windowFor`'s own short-circuit below rather than repeated
      // here, so that check keeps firing and the proof it carries keeps being
      // about a path something takes.
      if (poolIds.length === 0) return { start: floor, blocking: [], binding: [] };
      if (poolIds.length === 1) {
        const only = poolIds[0];
        const window = searches.windowFor(only, width, duration, floor);
        return {
          start: window.start,
          blocking: window.blocking,
          // The pool bound the slice exactly where it moved it off the floor.
          // At the floor it is the placement's tie rule that decides, and
          // `capacity` loses a tie — see {@link ScheduleFloor} — so a binding
          // entry there would be a team named on a slice nothing held up.
          binding: window.start > floor ? [{ poolId: only, blocking: window.blocking }] : [],
        };
      }

      const blocking = new Set<number>();
      let candidate = floor;
      let binding: { poolId: string; blocking: number[] }[] = [];
      for (;;) {
        let best = candidate;
        let reached: { poolId: string; blocking: number[] }[] = [];
        for (const poolId of poolIds) {
          const window = searches.windowFor(poolId, width, duration, candidate);
          for (const node of window.blocking) blocking.add(node);
          if (window.start > best) {
            best = window.start;
            reached = [{ poolId, blocking: window.blocking }];
          } else if (window.start === best && window.start > candidate) {
            reached.push({ poolId, blocking: window.blocking });
          }
        }
        if (best === candidate) return { start: candidate, blocking: [...blocking], binding };
        binding = reached;
        candidate = best;
      }
    },

    /** Writes a placed block's two events onto every pool it spends, tagged with the node holding them. */
    reserve(
      poolIds: readonly string[],
      node: number,
      width: number,
      start: number,
      finish: number,
    ): void {
      if (width === 0 || finish === start) return;
      // One reservation per pool, of the block's **whole** width: every named
      // team spends its own days (Dany, 2026-08-13, decision 3). Splitting the
      // width between them would be the other reading of "three teams on a
      // five-day slice", and it is the one he ruled out.
      for (const poolId of poolIds) {
        const pool = poolFor(poolId);
        const opens = eventAt(pool, start);
        opens.delta += width;
        opens.acquires.push(node);
        const closes = eventAt(pool, finish);
        closes.delta -= width;
        closes.releases.push(node);
      }
    },

    /** How many aggregated events every search of this run has visited together. */
    eventsVisited: (): number => visited,
  };

  return searches;
}

/**
 * Where a work item's span is currently measured from: a start, and the slice
 * it is the start of.
 *
 * A work item's slices are placed from one anchor for as long as they tile —
 * which keeps the arithmetic identical to a single node of the summed length,
 * see {@link schedule}. The first slice a person holds back does not tile, and
 * the anchor moves to it: from there the span is measured again.
 */
interface SpanAnchor {
  start: number;
  at: number;
}

/** What a slice's turn is decided by, in the order the decision is made. */
interface SlicePriority {
  /**
   * What somebody said this work is worth, smaller first — or `Infinity` where
   * nobody has said anything.
   *
   * The only one of these four a person writes, and therefore the first asked:
   * a planner who priorities two work items is overruling the engine's own guess at
   * which of them matters, and a rule that asked the guess first would make the
   * priority decide only the cases the guess could not.
   *
   * `Infinity` rather than a large number or a null: it is the value that makes
   * "no priority goes last" arithmetic rather than a special case, and it is what
   * makes a plan that priorities nothing schedule byte for byte as it did before
   * this field existed — every slice ties here and the three below decide alone.
   */
  priority: number;
  /** Where the critical path puts it, with nobody's calendar in the way. */
  start: number;
  /** How much it could slip there without moving the project. */
  float: number;
  /** Its work item's number — the tie goes to the row that reads first. */
  number: string;
  /** Its place in the role order, which is the last thing two slices can differ by. */
  at: number;
}

/**
 * A binary heap of slice nodes — the eligible set, kept in priority order.
 *
 * A sorted array rescanned for the first eligible slice is quadratic in the
 * slices, and the plans this has to hold are thousands of them. `O(log n)` per
 * placement is what keeps the whole pass at `O(V log V + E)`.
 */
function eligibleSet(goesFirst: (left: number, right: number) => boolean) {
  const heap: number[] = [];
  const swap = (a: number, b: number): void => {
    const held = heap[a];
    heap[a] = heap[b];
    heap[b] = held;
  };
  return {
    push(node: number): void {
      heap.push(node);
      for (let at = heap.length - 1; at > 0; ) {
        const parent = (at - 1) >> 1;
        if (!goesFirst(heap[at], heap[parent])) break;
        swap(at, parent);
        at = parent;
      }
    },
    take(): number | undefined {
      const top = heap[0];
      const last = heap.pop();
      if (last !== undefined && heap.length > 0) {
        heap[0] = last;
        for (let at = 0; ; ) {
          const left = at * 2 + 1;
          const right = left + 1;
          let first = at;
          if (left < heap.length && goesFirst(heap[left], heap[first])) first = left;
          if (right < heap.length && goesFirst(heap[right], heap[first])) first = right;
          if (first === at) break;
          swap(at, first);
          at = first;
        }
      }
      return top;
    },
  };
}

/**
 * **Deterministic serial list scheduling**: one pass, one eligible set, every
 * slice placed once and never moved.
 *
 * Repeatedly: take the highest-priority slice whose plan predecessors are all
 * placed, and put it at the latest of its floors — those predecessors'
 * finishes, its work item's manual floor, and the finish of whatever its
 * assignee is already doing. Its successors become eligible, and the pass moves
 * on. Nothing is revisited.
 *
 * **Non-overlap holds by construction.** A person's next slice is only ever
 * placed after their previous one is final, so two slices of one person cannot
 * share a day — no re-run can re-open what one pass never opened. This is what
 * the algorithm it replaced could not say: that one levelled at critical-path
 * times, then re-ran the forward pass once, and a dependency push could land a
 * slice on top of a person's later work that had not overlapped anything when
 * the overlaps were looked for.
 *
 * **It terminates, and it is not optimal.** Termination is structural: the plan
 * edges are acyclic or nothing is eligible at all, and a resource edge always
 * points from a slice already placed to one that is not, so it can never close
 * a loop. Optimality is not claimed and is not true — list scheduling is a
 * heuristic, and a different priority rule can finish a resource-constrained
 * plan sooner. What it is instead is **deterministic**: the same plan schedules
 * the same way every time, which is what a person reading dates needs.
 *
 * `personOf` rather than the slice's own `personId` so the same pass can be run
 * with the people taken out — that run is the critical path this one ranks by,
 * and running it through this code rather than a second implementation is what
 * makes "a plan with nobody assigned does not move" true by construction.
 */
function placeSlices(
  graph: SliceGraph,
  goesFirst: (left: number, right: number) => boolean,
  /**
   * Whether people's queues and teams' pools constrain this run.
   *
   * Both together, because they are the same kind of fact — a resource the plan
   * does not create more of — and the run with them off is the critical path
   * this one ranks by. Splitting them would make the ranking depend on
   * capacity, which is a placement decision.
   */
  withResources: boolean,
  sizes: PoolSizes,
): {
  order: number[];
  placed: Placed[];
  resourceSuccessors: number[][];
  eventsVisited: number;
} {
  const { nodes } = graph;
  const waitingOn = nodes.map((node) => node.predecessors.length);
  const eligible = eligibleSet(goesFirst);
  for (let node = 0; node < nodes.length; node += 1) if (waitingOn[node] === 0) eligible.push(node);

  const placed: Placed[] = [];
  const order: number[] = [];
  const anchorOf = new Array<SpanAnchor | undefined>(graph.items);
  /** Each person's last placement — their finishes only ever go up, so it is also their latest. */
  const busyUntil = new Map<string, { node: number; finish: number }>();
  const resourceSuccessors = nodes.map((): number[] => []);
  const profile = capacityProfile(sizes);
  /** Which step of `order` each node was placed at, which breaks the display referent's ties. */
  const placedAt = new Array<number>(nodes.length).fill(0);

  for (let taken = eligible.take(); taken !== undefined; taken = eligible.take()) {
    const node = nodes[taken];
    const { offsets, at } = node;

    let fromPredecessor = 0;
    let fromRoleOrder = 0;
    for (const earlier of node.predecessors) {
      const { finish } = placed[earlier];
      if (nodes[earlier].item === node.item) fromRoleOrder = Math.max(fromRoleOrder, finish);
      else fromPredecessor = Math.max(fromPredecessor, finish);
    }
    // A slice of no length is not work, so it neither waits for its assignee
    // nor makes them busy: nobody is occupied for zero days. Without this an
    // unestimated `QA` belonging to somebody would queue behind everything else
    // they are doing and drag its work item's finish along with it — a row that
    // ends on day 3 reported as ending on day 5 because a slice with nothing in
    // it was placed there.
    //
    // Proof: the length dropped from this condition and `gives a slice nobody
    // has estimated no place in the queue` failed — the empty `QA` came back at
    // day 5 rather than day 3, `boundBy: 'person'`, taking its work item's
    // finish with it; watched 2026-08-09.
    const duration = offsets[at + 1] - offsets[at];
    const personId = withResources && duration > 0 ? node.slice.personId : null;
    const busy = personId === null ? undefined : busyUntil.get(personId);
    // The same rule as the person's, one line along: a slice of no length
    // spends nobody's slots, and neither does one no sized team labels. The run
    // with the resources taken out is the critical path, and it has no pools in
    // it at all.
    const poolIds = withResources ? node.slice.poolIds : [];
    const { width } = node.slice;
    // Where the plan alone would put it: the floors that do not depend on a
    // resource, plus the person's queue. The pool is asked **from** here, which
    // is what "at or after the floor" means.
    const planFloor = Math.max(
      fromPredecessor,
      fromRoleOrder,
      node.notBefore,
      busy === undefined ? 0 : busy.finish,
    );
    const window = profile.jointWindowFor(poolIds, width, duration, planFloor);
    // Latest wins, and a tie keeps the reason listed first — which is why the
    // person is second to last and capacity is last; see {@link ScheduleFloor}.
    // A slice can carry both, because a team's slot is spent whether or not
    // somebody is named on the work, so the order decides a real case.
    //
    // Proof: the person floor deleted from this list and nine leveling tests
    // failed, `runs two work items assigned to one person one after the other`
    // among them — `b` came back at 0→2 while `kat` was on `a` until day 3;
    // watched 2026-08-09.
    //
    // Proof: the capacity entry deleted from this list and `waits for a team's
    // slots to come free before it starts` failed — the third block on a team
    // of two came back at day 0 with `boundBy: 'projectStart'`; watched
    // 2026-08-12.
    //
    // Proof: the capacity entry moved above `person` and `names the person, not
    // the pool, when the two land on the same day` failed — not by naming
    // `capacity` where the assignee was owed the sentence, which is what the
    // reorder was predicted to do, but one layer earlier. In that fixture both
    // floors are day 3, so the window search starts at its answer and steps
    // over nothing: `capacity` takes the tie with an **empty** blocking set,
    // the referent below stays `NOBODY`, and the invariant at the end of this
    // block throws `b role-dev waited for capacity with nothing holding the
    // pool`. Recorded as observed, which is also what `verify.md`'s F8 row
    // says; watched 2026-08-12.
    const floors: { at: number; kind: ScheduleFloor }[] = [
      { at: fromPredecessor, kind: 'predecessor' },
      { at: fromRoleOrder, kind: 'roleOrder' },
      { at: node.notBefore, kind: 'notBefore' },
      ...(busy === undefined ? [] : [{ at: busy.finish, kind: 'person' as const }]),
      { at: window.start, kind: 'capacity' as const },
    ];
    let start = 0;
    let boundBy: ScheduleFloor = 'projectStart';
    for (const floor of floors) {
      // Strictly later, so a tie keeps the floor named first. Proof: written as
      // `<`, so that a later floor takes a tie, and `names the predecessor, not
      // the person, when the two land on the same day` failed — a row whose
      // assignee came free exactly as its dependency cleared was reported as
      // waiting for her, and counted into "N tasks wait for a person"; watched
      // 2026-08-09.
      if (floor.at <= start) continue;
      start = floor.at;
      boundBy = floor.kind;
    }

    // The anchor is kept while the work item's slices tile — the arithmetic
    // then reads `base + offsets[i]`, which is what the engine before slices
    // computed and what the identity claim rests on. A slice a person held
    // back does not tile, and becomes the anchor the rest are measured from.
    const anchor = anchorOf[node.item];
    const held =
      anchor !== undefined && start === anchor.start + (offsets[at] - offsets[anchor.at])
        ? anchor
        : { start, at };
    anchorOf[node.item] = held;
    // Proof: written as `start + (offsets[at + 1] - offsets[at])` — the
    // textbook `start + days`, accumulated from slice to slice — and `answers
    // what the previous engine answered` failed at seed 260: a work item's late
    // start of 10.666666666666666 became 10.666666666666668; watched
    // 2026-08-09.
    const finish = held.start + (offsets[at + 1] - offsets[held.at]);
    // Only where the pool is what held it: a set carried on a slice the pool
    // let through would be a wait that is not there, in the same way an arrow
    // for a resource edge that did not bind would be.
    // A conservative scan records every reservation present at a violated
    // instant. Only reservations that finish by the accepted start are actual
    // predecessors: a narrower reservation may continue alongside this slice.
    // Promoting that overlap into the backward graph gives it a late finish
    // before its early finish and exposes negative public float.
    const finishesByStart = (blocker: number): boolean => placed[blocker].finish <= start;
    const capacityPredecessors =
      boundBy === 'capacity' ? window.blocking.filter(finishesByStart) : [];
    /**
     * Which pool ran out, of the ones that pinned the start.
     *
     * The tightest team, and where two are equally tight the one whose blocking
     * set holds the latest valid finisher. Ties past that by pool id. Keep the
     * chosen pool's valid blockers with it: the public referent below must come
     * from the team the sentence names, not from an independently ordered union.
     *
     * A slice a pool did not hold up carries null, exactly as it carries an
     * empty blocking set: a team named on a slice nothing held up is a wait
     * that is not there, in the same way a resource arrow would be.
     */
    let capacityTeamId: string | null = null;
    let capacityTeamBlockers: number[] = [];
    let bestFinish = -Infinity;
    for (const pool of window.binding) {
      const validBlockers = pool.blocking.filter(finishesByStart);
      let finish = -Infinity;
      for (const blocker of validBlockers) finish = Math.max(finish, placed[blocker].finish);
      if (
        finish > bestFinish ||
        (finish === bestFinish && capacityTeamId !== null && pool.poolId < capacityTeamId)
      ) {
        bestFinish = finish;
        capacityTeamId = pool.poolId;
        capacityTeamBlockers = validBlockers;
      }
    }
    /**
     * Which of the blocking set the arrow points at: the latest finisher, ties
     * to the one placed first.
     *
     * A display referent and nothing more — the graph below keeps the complete
     * valid union. Selection is restricted to the chosen binding pool so the
     * named team and arrow remain one causal explanation. Within that pool the
     * latest finisher is the end the reader is looking at; ties use placement
     * order rather than node index, preserving the pass's own total order.
     */
    let referent = NOBODY;
    for (const blocker of capacityTeamBlockers) {
      if (referent === NOBODY) {
        referent = blocker;
        continue;
      }
      if (placed[blocker].finish > placed[referent].finish) referent = blocker;
      else if (
        placed[blocker].finish === placed[referent].finish &&
        placedAt[blocker] < placedAt[referent]
      ) {
        referent = blocker;
      }
    }
    // A capacity-floored slice with an empty blocking set is impossible — the
    // floor is the search's own answer and the search records what it stepped
    // over — so it is a throw rather than a null the render path would have to
    // invent words for. `floorWordsOf`'s existing refusal, one layer down.
    //
    // Proof: the search made to hand back an empty set (its dependency
    // deliberately broken) **and** this throw replaced by the fall-through it
    // refuses — the two faults the invariant stands between — and `waits for a
    // team's slots to come free before it starts` failed on
    // `resourcePredecessorId: null` with `boundBy: 'capacity'`: a bar claiming
    // a wait and naming nothing. With the throw restored the same broken search
    // fails here instead, which is the point of it; watched 2026-08-12.
    if (boundBy === 'capacity' && referent === NOBODY) {
      throw new Error(`${node.key} waited for capacity with nothing holding the pool`);
    }
    // **Read off the search rather than gated on `boundBy`, and then checked
    // against it.** The two are the same fact — a pool binds exactly where it
    // pushed the block off the plan floor, and a floor strictly past the plan's
    // own is what `capacity` means — so a gate here would be a restatement
    // that cannot fail, which is the one thing this repo has been bitten by
    // repeatedly. Written as the invariant instead, where an injected fault on
    // either side of it reddens.
    //
    // Proof: `binding` handed back without its `start > floor` condition — the
    // shape of a pool that had room being called the reason — and `names no
    // team on a slice no pool held up` failed here on `first role-dev names
    // team-alpha with no pool binding it`; watched 2026-08-14.
    if ((boundBy === 'capacity') !== (capacityTeamId !== null)) {
      throw new Error(
        capacityTeamId === null
          ? `${node.key} waited for capacity with no pool binding it`
          : `${node.key} names ${capacityTeamId} with no pool binding it`,
      );
    }
    placed[taken] = {
      start,
      finish,
      boundBy,
      resourcePredecessor:
        boundBy === 'person' && busy !== undefined
          ? busy.node
          : boundBy === 'capacity'
            ? referent
            : NOBODY,
      capacityPredecessors,
      capacityTeamId,
    };
    placedAt[taken] = order.length;
    order.push(taken);

    // The reservation, written once and never moved — which is what makes the
    // scan above read a profile that cannot change under it, and therefore what
    // makes the placement terminate.
    profile.reserve(poolIds, taken, width, start, finish);
    // The edges the pool chose: every reservation that had to end for this
    // block to fit, each pointing at the block. The **whole** set, because a
    // single edge reports float that is not there — see
    // {@link ScheduledSlice.capacityPredecessorIds}. Every one of them is
    // already placed, so the augmented graph stays acyclic in placement order.
    //
    // Proof: narrowed to the display referent alone — one edge, from the latest
    // finisher — and `reports no float on a block whose slack another block's
    // finish is holding` failed with A's float coming back as 5 rather than 2:
    // a row reported as movable that cannot move; watched 2026-08-12.
    for (const blocker of capacityPredecessors) resourceSuccessors[blocker].push(taken);

    if (personId !== null) {
      // The edge the pass chose: this person's work, in the order it will be
      // done. It is a real precedence constraint of the plan that comes out,
      // so the backward pass runs over it too.
      if (busy !== undefined) resourceSuccessors[busy.node].push(taken);
      // Where the slice actually landed, which is the whole difference between
      // this algorithm and the one it replaced. Proof: recorded as that slice's
      // **critical-path** finish instead — one forward re-run over stale
      // numbers, which is what v1 did — and `does not re-overlap a person
      // downstream of a dependency push` failed, alone: `r` came back at 5→7 on
      // top of `q` at 4→6, `boundBy: 'predecessor'`; watched 2026-08-09.
      busyUntil.set(personId, { node: taken, finish });
    }
    for (const next of node.successors) {
      waitingOn[next] -= 1;
      if (waitingOn[next] === 0) eligible.push(next);
    }
  }

  // The eligible set emptied with slices left over: the only way that happens
  // is a loop in the plan's own edges, since a resource edge always points from
  // something already placed. Proof: this throw deleted and `throws on a cyclic
  // graph rather than returning a schedule` failed with `undefined is not an
  // object (evaluating 'unleveled.placed[at].start')` — an untyped error a
  // reader would meet as a 500 on the whole project, where this one is what
  // `tree` turns into the banner saying why the plan has no dates; watched
  // 2026-08-09.
  if (order.length !== nodes.length) throw new ScheduleCycleError();
  return { order, placed, resourceSuccessors, eventsVisited: profile.eventsVisited() };
}

/**
 * Every leaf's priority, taken from the nearest row above it that carries one.
 *
 * A priority written on a parent reaches every leaf beneath it, exactly as a
 * dependency and a floor do — and it resolves by the **most specific**
 * statement, which is deliberately not the floor rule. A floor takes the latest
 * of everything that applies because a floor is a hard constraint and the
 * strictest of them must hold; a priority is somebody's statement of what
 * matters, and the one written closest to the work is the one that meant that
 * work. So a leaf's own beats its parent's in **both** directions, and the
 * nearer of two ancestors beats the further.
 *
 * Leaves with nobody's priority above them are simply absent, which is what
 * `goesFirst` reads as `Infinity`.
 *
 * The upward walk terminates because {@link indexTree} has already walked the
 * same tree downward: a loop among the parents is a loop among the children,
 * and that walk would not have returned.
 *
 * Proof: written as the floor rule — the smallest priority of the leaf and
 * every ancestor — and two tests in `schedule-priority.test.ts` failed: `lets a
 * leaf's own priority beat its parent's, in both directions` on the leaf carrying
 * 5 under a parent carrying 1 taking the person at day 0 from the standalone 2,
 * and `gives the nearer ancestor's priority to a leaf between two` on the same
 * inversion; watched 2026-08-11.
 */
function priorityByLeaf(rows: readonly WorkItem[], index: TreeIndex): Map<string, number> {
  const parentOf = new Map(rows.map((row) => [row.id, row.parentId]));
  const ownPriority = new Map(rows.map((row) => [row.id, row.priority]));
  const found = new Map<string, number>();
  for (const leafId of index.leafIds) {
    for (
      let cursor: string | null | undefined = leafId;
      cursor !== null && cursor !== undefined;
    ) {
      const own = ownPriority.get(cursor);
      if (own !== undefined && own !== null) {
        found.set(leafId, own);
        break;
      }
      cursor = parentOf.get(cursor);
    }
  }
  return found;
}

/** One slice's late times: the last it may finish, and the last it may start. */
interface Late {
  latestStart: number;
  latestFinish: number;
}

/**
 * How late every slice may run without moving the project, over the graph it is
 * handed — which for the schedule that comes out includes the resource edges.
 *
 * Backwards through the order the slices were placed in, which is a topological
 * order of that graph: every successor is settled before the slice it follows.
 *
 * The late times are anchored from the **end** of a work item's span for the
 * same reason the early ones are anchored from its start: `ceiling - (total -
 * offsets[i])` is what the engine before slices computed, and accumulating
 * `finish - days` down the chain differs from it in the last bits — which
 * `datesOf` can turn into a whole day. The anchor moves when a slice's late
 * finish is not the one the tiling implies, which is what a person's queue
 * pulling one slice earlier than its own chain does.
 *
 * `hasQueues` turns on the **tight-path rule**: a slice that cannot move at all
 * takes its late start from the early pass rather than reconstructing it by
 * subtraction. Both are the same number in arithmetic — `latestFinish ===
 * earliestFinish` means `latestFinish - days === earliestStart` — and not in
 * doubles: `(4/3 + 1) - 1` is not `4/3`, so a queue that is the longest path
 * there is reports a float of `-2.2e-16` and paints neither of its rows red.
 *
 * It is on only when the placement made a queue, and that scoping is the whole
 * identity claim rather than caution: a plan with nobody assigned has to answer
 * what the engine before this one answered, **including** where that engine
 * drifted the same way on an ordinary critical path. Fixing that is a change
 * that moves numbers in every plan that exists, and it is not this one.
 *
 * Proof that the scoping is load-bearing: with `hasQueues` dropped, so the rule
 * applies to every plan, the differential failed at seed 2 —
 * `r1c0g0.latestStart` `4.666666666666666` became `4.666666666666667`, on a
 * plan nobody is assigned to; watched 2026-08-09.
 */
function lateTimes(
  graph: SliceGraph,
  order: readonly number[],
  successorsOf: readonly (readonly number[])[],
  projectFinish: number,
  placed: readonly Placed[],
  hasQueues: boolean,
): Late[] {
  const { nodes } = graph;
  const late: Late[] = [];
  const anchorOf = new Array<{ finish: number; at: number } | undefined>(graph.items);
  for (let step = order.length - 1; step >= 0; step -= 1) {
    const taken = order[step];
    const node = nodes[taken];
    const { offsets, at } = node;
    const successors = successorsOf[taken];
    let finish = projectFinish;
    for (const next of successors) {
      const settled = late[next].latestStart;
      if (settled < finish) finish = settled;
    }

    // The tight-path rule. Proof: with this branch removed, `reports a queue
    // that ends the project as critical, exactly` failed on `a`'s late start —
    // `Expected: 0 Received: -2.220446049250313e-16` — and, with that
    // assertion taken out of the way, on `b`'s: `Expected: 1.3333333333333333
    // Received: 1.333333333333333`; watched 2026-08-11.
    //
    // It is watched on the late starts and nowhere else. Under the same fault
    // the whole of `apps/be-01` was green before those two assertions existed:
    // the -2.2e-16 the rule exists to prevent is inside `slackOf`'s window, so
    // the `float` and `critical` assertions in that test — and every
    // differential — report the snapped answer either way. What the rule buys
    // is the number the engine hands out verbatim, not the colour.
    const early = placed[taken];
    if (hasQueues && finish === early.finish) {
      anchorOf[node.item] = { finish, at };
      late[taken] = { latestFinish: finish, latestStart: early.start };
      continue;
    }

    const anchor = anchorOf[node.item];
    const held =
      anchor !== undefined && finish === anchor.finish - (offsets[anchor.at + 1] - offsets[at + 1])
        ? anchor
        : { finish, at };
    anchorOf[node.item] = held;
    late[taken] = {
      latestFinish: finish,
      // Proof: written as `finish - (offsets[at + 1] - offsets[at])` — the
      // textbook `finish - days` — and the differential failed at seed 255 with
      // a late start of 0 becoming 6.661338147750939e-16, which is a row that
      // had no slack acquiring some and losing its red; watched 2026-08-09.
      latestStart: held.finish - (offsets[held.at + 1] - offsets[at]),
    };
  }
  return late;
}

/**
 * A row's slack: how far its late start is after its early one, with
 * accumulated floating-point drift snapped out — and therefore the one number
 * `critical` is read off.
 *
 * Both ends come out of chains of double additions the engine deliberately
 * reports verbatim, so a row that cannot slip by so much as an hour subtracts
 * to ±1e-15 rather than to 0. Three PERT sixths summing to exactly 15 arrive as
 * 15.000000000000002 (`snapWorkdays`' own example), every row that ends there
 * inherits the drifted bit, and an exact `=== 0` reads it as slack: cloud case
 * A1, live on dev — a chain and a flat row all ending the project, Slack
 * printing `0` on each of them and only one carrying `critical`.
 *
 * {@link snapWorkdays}, at the same 1e-9 window the calendar boundaries use,
 * because this is the same step: a continuous offset becoming a discrete
 * answer, here `critical` rather than a date. Sharing the window is what makes
 * the two agree — a difference the calendar has already decided is not a day
 * cannot be a difference the Slack column decides is float. Applied to the
 * **reported** slack and not only to the comparison, so what the column prints
 * and what the red says are the same number.
 *
 * The snap is on slack alone. `latestStart` and `latestFinish` stay verbatim,
 * and so does the leveller's own float — its priority rule ranks genuinely
 * different floats and must keep separating two rows the schedule can tell
 * apart. Real slack survives untouched at the sizes plans are written in: a
 * PERT final over whole-day estimates lands on a multiple of a sixth of a day,
 * eight orders of magnitude above the window, and a test on this path holds it.
 *
 * Smaller is expressible, and the window does eat it. `ThreePointEstimate` is
 * three `number>=0` with no floor under them, so a plan may put 5e-10 of a day
 * against a row, and slack that size snaps to `0` and reads `critical`. That is
 * an accepted edge rather than a case this cannot reach: a row with less than a
 * billionth of a workday to spare is a row that cannot move, and red is the
 * answer a reader wants for it. The window is chosen against the fractions
 * estimates are given in, not against every double the type admits.
 *
 * `-0` is normalised because a drifted zero is as often below as above. It is
 * `0` to `===` and to the reader — same colour, same printed slack — and it is
 * **not** `0` to `Object.is`, which is what `toBe` and `toMatchObject` compare
 * with, so leaving it would make the fixed answer unassertable.
 *
 * Proof, both watched 2026-08-11 and each fault then reverted:
 *
 * - the `snapWorkdays` call dropped (a bare `latestStart - earliestStart`) and
 *   four tests failed — `paints every row that ends the project red, drift and
 *   all` on `critical: false` with a float of `8.881784197001252e-16` for
 *   `chain-a`, which is case A1's own shape; `reports no float on a row a
 *   notBefore floor stands at the project finish` on `Expected: 0 Received:
 *   -1.7763568394002505e-15`; and both differential tests in
 *   `schedule-identity.test.ts`, `seed 1, r0c0g0.float: 0 became
 *   -1.7763568394002505e-15`.
 * - the `-0` normalisation dropped instead, and the floor test failed alone,
 *   on `Expected: 0 Received: -0` — the same day on screen and a different
 *   number to `Object.is`.
 */
function slackOf(latestStart: number, earliestStart: number): number {
  const slack = snapWorkdays(latestStart - earliestStart);
  return slack === 0 ? 0 : slack;
}

/**
 * The schedule for a project: computed in slices, and levelled so that one
 * person does one thing at a time.
 *
 * Two passes of {@link placeSlices}. The first has the people taken out and is
 * the ordinary critical path — the numbers this engine has always answered, and
 * the priorities the second ranks by. The second is the plan that comes out:
 * the highest-priority eligible slice placed at the latest of its floors, one
 * of which is its assignee's last finish. {@link lateTimes} then runs backwards
 * over the **augmented** graph — the plan's edges and the resource ones the
 * placement chose — so slack and `critical` describe the plan a person will
 * actually work, not one where everybody is in two places at once.
 *
 * A plan with nobody assigned has no resource edges and no person floors, so
 * the second pass is the first pass and every number is what it was before
 * leveling existed. That is asserted rather than argued: a thousand seeded
 * plans and one captured live plan go through this engine and the one it
 * replaced, and every field is compared with `toBe`.
 *
 * `slices` holds one entry per leaf and role, in **role order** — the order the
 * work runs in, so a leaf's `Dev` finishes before its `QA` starts. Every leaf
 * needs at least one, which is the adapter's job: a project holding no roles
 * gives each leaf one slice belonging to nobody, so the plan still schedules.
 * A slice nobody has estimated is zero days long and imposes no wait, but it is
 * still a node, which is how an unestimated `Dev` in front of an estimated `QA`
 * hands `QA` its work item's predecessors.
 *
 * Edges are taken as written and expanded here: one declared on a parent means
 * every leaf beneath its predecessor has its **anchor slice** finish before
 * every leaf beneath its successor starts, which is "all of 010's first-role
 * work before any of 020" (Dany's rule, 2026-08-11: a dependency waits on the
 * predecessor's Dev, never on its QA).
 *
 * The anchor is the first slice in role order **that somebody estimated** —
 * "first in list of project roles, then first that is estimated", his words —
 * and the work item's finish when nobody estimated any of it. A `Design` role
 * the project lists and this plan left blank therefore does not stand in
 * front of the `Dev` the wait is really about; without that walk every edge
 * in such a plan would anchor on a zero-length slice and decide nothing.
 *
 * On the **successor** side the edge lands on the first slice plain, never
 * the first estimated one: that would leave an unestimated `Dev` with no
 * predecessor at all and start the row before the thing it waits for. The
 * asymmetry is the point — see `design.md` D2. The predecessor's slices
 * behind its anchor are free to run in parallel with the successor. Edges
 * still touch only slices of one item's own chain and those chains are
 * private, forward-only paths, so a cycle is still a property of the leaf
 * graph alone and {@link hasCycle} still answers for it.
 *
 * **The arithmetic is anchored on each work item's own start**, not accumulated
 * from slice to slice: a slice finishes at `base + offsets[i + 1]` rather than
 * at `start + days`. `(base + a) + b` is not `base + (a + b)` in doubles — with
 * a PERT base of `3.6666666666666665` and two sixth-of-a-day slices the first
 * gives `3.9999999999999996` and the second gives exactly `4`, and `datesOf`
 * reads a finish through `Math.ceil`, so that bit is a whole day on screen.
 * Anchoring is what makes this engine answer what its predecessor answered.
 * With nobody assigned nothing but the plan constrains a slice, so the
 * anchoring is also what the graph says: external edges *arrive* only at a
 * work item's first slice, and where they *leave* from does not matter — an
 * outgoing edge imposes no floor on the slice it leaves. (They now leave the
 * first slice too; the backward pass never assumed otherwise — it walks the
 * adjacency as built.) A person is what breaks that, and the anchor moves to
 * the slice they held back — see {@link SpanAnchor}.
 *
 * Everything here is an offset from day zero, in **working days**. The calendar
 * lives one layer up: `work-item.service` turns the project's start date and
 * these offsets into dates with `addWorkdays`, and turns a manual "start no
 * earlier than" date back into the `notBefore` offsets below. Keeping the pass
 * itself in numbers means weekends are counted in exactly one place.
 */
export function schedule(
  rows: readonly WorkItem[],
  edges: readonly DependencyEdge[],
  slices: readonly Slice[],
  /**
   * The earliest offset each work item may start at, from a manual constraint.
   *
   * Taken as a floor alongside the predecessors' finishes, never as a pin: a
   * work item told "not before day 10" whose predecessor finishes on day 14
   * starts on day 14. Dany's call — the constraint may only ever push an item
   * later, so the dependency tree and the calendar cannot contradict each
   * other. A work item absent from the map is unconstrained. It applies to the
   * work item's **first** slice, and thereby to all of them.
   *
   * A floor keyed by a **parent** reaches every leaf beneath it, exactly as a
   * dependency declared on a parent does: "this phase starts no earlier than
   * the 12th" means none of its work does. Each leaf takes the latest of its
   * own floor and every ancestor's — see the expansion below.
   */
  notBefore: ReadonlyMap<string, number> = new Map(),
  /**
   * How many slots each pool holds, by pool id — see {@link PoolSizes}.
   *
   * Empty by default, which is every plan whose teams nobody has sized and
   * therefore every plan that exists today: with no entry here no slice can
   * carry a pool, so nothing reserves anything and the placement is the one
   * this engine performed before capacity existed.
   */
  poolSizes: PoolSizes = new Map(),
): Schedule {
  const index = indexTree(rows);
  const { leafIds } = index;
  const sliced = groupByWorkItem(leafIds, slices);

  /**
   * One leaf's slices, or a throw.
   *
   * A leaf the adapter handed no slice for cannot be scheduled and must not be
   * quietly dropped: every edge through it would vanish with it and the rows
   * around it would move.
   *
   * Proof: with this returning an empty group instead, `refuses a leaf it was
   * handed no slice for` gets a schedule back with the leaf missing and its
   * successor starting on day zero; watched 2026-08-09.
   */
  const slicesOf = (workItemId: string): WorkItemSlices => {
    const found = sliced.get(workItemId);
    if (found === undefined) throw new Error(`no slice for work item ${workItemId}`);
    return found;
  };

  // Expanded here rather than stored. Storing it would be a second copy to fall
  // out of date with the tree the moment a leaf is added under either end.
  const leafEdges = expandToLeaves(index, edges);

  // Floors expanded down the tree the same way the edges are: a floor keyed by
  // any row constrains every leaf beneath it, and each leaf keeps the
  // **latest** of its own floor and every ancestor's. `Math.max`, never a
  // copy-down — a parent's day 3 must not overwrite a child's own day 9.
  // Until 2026-08-10 this map was read for leaf ids alone, so a floor written
  // on a parent was accepted, stored, echoed back — and constrained nothing;
  // `floors every leaf beneath a parent told not to start before a day`
  // (`work-item.service.test.ts`) was watched failing on the leaf starting
  // `2026-08-06` under a parent floored to `2026-08-12`.
  //
  // Proof: the `Math.max` replaced with a bare copy-down (`set(leafId,
  // atLeast)`) and two tests in `schedule-shapes.test.ts` failed — `composes
  // ancestor floors with a dependency, each leaf keeping its own maximum` on
  // `L2` at `earliestStart: 5` where its own day-9 floor was owed, and
  // `carries a grandparent's floor two levels down to the leaf` on
  // `earliestStart: 3` where the grandparent's day 6 was; watched 2026-08-10.
  const leafFloors = new Map<string, number>();
  for (const [flooredId, atLeast] of notBefore) {
    for (const leafId of index.leavesUnder.get(flooredId) ?? []) {
      leafFloors.set(leafId, Math.max(leafFloors.get(leafId) ?? 0, atLeast));
    }
  }

  /**
   * The nodes, in the order they run: every leaf's slices in role order, and
   * the intra-item chain between them.
   *
   * A group is never empty — {@link groupByWorkItem} only creates one because a
   * slice went into it — so a leaf's first and last node are its first and last
   * slice. A leaf with no group at all is what `slicesOf` refuses, which is why
   * this loop asks it for every leaf before any edge is drawn.
   */
  const nodes: SliceNode[] = [];
  const firstNode = new Map<string, number>();
  const anchorNode = new Map<string, number>();
  let items = 0;
  for (const leafId of leafIds) {
    const { slices: own, offsets } = slicesOf(leafId);
    const item = items;
    items += 1;
    const first = nodes.length;
    own.forEach((slice, at) => {
      nodes.push({
        key: sliceKey(slice.workItemId, slice.roleId),
        slice,
        item,
        at,
        offsets,
        notBefore: at === 0 ? (leafFloors.get(leafId) ?? 0) : 0,
        predecessors: [],
        successors: [],
      });
    });
    for (let node = first + 1; node < nodes.length; node += 1) {
      nodes[node - 1].successors.push(node);
      nodes[node].predecessors.push(node - 1);
    }
    // Recorded only if the group put a node in. It always does — a group exists
    // because a slice created it — and the one thing that could make it not is
    // the fault `firstNodeOf` below names, which is why nothing is written for
    // a leaf with no node rather than a dangling index.
    if (nodes.length > first) {
      firstNode.set(leafId, first);
      // The **anchor**: the first slice in role order somebody estimated, and
      // the leaf's last slice when nobody estimated any of them. Dany's rule
      // in his own words (2026-08-11): "first in list of project roles, then
      // first that is estimated".
      //
      // `days !== null` and not `days > 0`, which is what `Scheduled.estimated`
      // means everywhere else in this engine: an explicit zero is somebody
      // saying this role takes no time, and the anchor honours the statement
      // rather than second-guessing it. Nobody having said anything is the
      // different fact, and it is the one this walk steps over.
      //
      // The fall-through is the **last** node rather than the first, so the
      // edge leaves the work item's finish. For a leaf nothing is estimated on
      // that finish *is* its start, so the edge imposes exactly what the leaf's
      // own predecessors imposed and nothing more — the degenerate case, kept
      // as a stated consequence.
      const estimated = own.findIndex((slice) => slice.days !== null);
      anchorNode.set(leafId, estimated === -1 ? nodes.length - 1 : first + estimated);
    }
  }

  /**
   * Where a leaf's slices begin among the nodes — the node an external edge
   * arrives at. It leaves from {@link anchorNodeOf}, which is not always
   * this one.
   *
   * Every leaf has an entry: the loop above made one for each of them, and
   * refused the leaf it was handed no slice for. It throws rather than skipping
   * because a dependency quietly dropped is a plan whose rows are all real and
   * whose dates are for a different plan.
   *
   * Proof: with `slicesOf` returning an empty group instead of throwing — the
   * fault `schedule-on-item-role` documents — `refuses a dependency onto a leaf
   * it has no slice for` failed here, `no slice for work item leaf-2`, instead
   * of coming back with the row missing and the edge ignored; watched
   * 2026-08-09.
   */
  const firstNodeOf = (leafId: string): number => {
    const found = firstNode.get(leafId);
    if (found === undefined) throw new Error(`no slice for work item ${leafId}`);
    return found;
  };

  /**
   * The leaf's **anchor** node — where an external edge leaves it. Recorded
   * beside {@link firstNode} above, and absent for exactly the leaf that map is
   * absent for, so this throws for the same reason and with the same words.
   */
  const anchorNodeOf = (leafId: string): number => {
    const found = anchorNode.get(leafId);
    if (found === undefined) throw new Error(`no slice for work item ${leafId}`);
    return found;
  };

  // The predecessor's **anchor** slice to the successor's **first**: the anchor
  // finishes before any of the successor starts, the predecessor's later roles
  // run in parallel with it, and the successor's own order carries the wait to
  // the roles behind its first. Pushed onto the two nodes rather than rebuilt
  // into a map — the adjacency is written once per edge.
  //
  // Proof: the join reverted to the predecessor's **last** node — the
  // whole-item rule this replaced — and `waits for the first role, not the
  // last` failed on `Expected: 3, Received: 5`, `a branch releases at its
  // anchors` on `Expected: 4, Received: 5` (`schedule-shapes.test.ts`);
  // watched 2026-08-11.
  //
  // Proof: `anchorNodeOf` replaced by `firstNodeOf` — the first slice plain,
  // this change's own predecessor — and four failed: `a chain does not
  // collapse because a project lists a role nobody estimated` on `c2`
  // `earliestStart` `Expected: 4, Received: 0`, `walks past an unestimated
  // role to the first one somebody estimated` on `Expected: 4, Received: 0`,
  // `a branch anchors each leaf on its own first estimate` on `Expected: 5,
  // Received: 0`, and `carries an unestimated predecessor's own wait through
  // to its successor` on `B` `earliestStart` `Expected: 3, Received: 0`;
  // watched 2026-08-11.
  for (const { predecessorId, successorId } of leafEdges) {
    const before = anchorNodeOf(predecessorId);
    const after = firstNodeOf(successorId);
    nodes[before].successors.push(after);
    nodes[after].predecessors.push(before);
  }
  const graph: SliceGraph = { nodes, items };

  // The same plan with nobody's calendar in it — the critical path, computed by
  // the pass above with the people taken out rather than by a second copy of
  // it. Its start and float are what the leveller ranks by, and its numbers are
  // exactly what this engine answers when nobody is assigned. The order it is
  // computed in is the order the nodes were built in, which is all a plan with
  // no queues in it needs.
  const unleveled = placeSlices(graph, (left, right) => left < right, false, poolSizes);
  const criticalPath = lateTimes(
    graph,
    unleveled.order,
    nodes.map((node) => node.successors),
    Math.max(0, ...unleveled.placed.map((each) => each.finish)),
    unleveled.placed,
    // The critical path is a ranking, not an answer, and it is the plan with
    // nobody in it by construction — there are no queues here to be tight about.
    false,
  );

  const numbers = deriveNumbers(rows);
  const leafPriorities = priorityByLeaf(rows, index);
  const priorityOf: SlicePriority[] = nodes.map((node, at) => ({
    // Both slices of one work item carry its priority, which is what keeps a priority a
    // fact about the work rather than about one of its phases.
    priority: leafPriorities.get(node.slice.workItemId) ?? Infinity,
    start: unleveled.placed[at].start,
    float: criticalPath[at].latestStart - unleveled.placed[at].start,
    // `deriveNumbers` covers every row or throws, so the fallback is
    // unreachable; it is a default rather than a throw because this is the
    // third of four tie-breaks and an empty string only ever reorders slices
    // that are already equal on time.
    number: numbers.get(node.slice.workItemId) ?? '',
    at: node.at,
  }));
  /**
   * The priority rule, in full: what somebody said matters most, then what the
   * critical path needs first, then what has least room to move, then the
   * plan's own order.
   *
   * The last two are what make it deterministic rather than merely correct.
   * Two slices that tie on time are separated by their work item's number and
   * then by their place in the role order, so the same plan cannot schedule two
   * ways — and no pair can tie on all five, since two slices of one work item
   * differ in the last.
   *
   * **This rule decides an order, never a date.** Whichever slice is taken
   * first is still placed at the latest of its own floors, so a priority cannot
   * put a work item in front of its dependencies, its floor or its earlier
   * roles — it decides who goes first where the schedule has a choice, which is
   * exactly the case where two slices are both eligible and want one person.
   *
   * Proof: the first two comparisons deleted, so that the plan's own order
   * decided, and two tests failed — `gives the queue to the slice that can
   * start soonest, before the one with less slack` put `kat` on a slice she
   * could not begin for three days and pushed the other out to 5→7, finishing
   * the project two days later than it needs to; watched 2026-08-09.
   *
   * Proof: the priority comparison deleted and 8 of the 11 tests in
   * `schedule-priority.test.ts` failed — `starts the smaller priority first
   * when two work items want one person` on the work item with the smaller
   * priority coming back at 3→5, behind the one it outranks and bound by
   * `person`; watched 2026-08-11.
   */
  const goesFirst = (left: number, right: number): boolean => {
    const first = priorityOf[left];
    const second = priorityOf[right];
    if (first.priority !== second.priority) return first.priority < second.priority;
    if (first.start !== second.start) return first.start < second.start;
    if (first.float !== second.float) return first.float < second.float;
    if (first.number !== second.number) return first.number < second.number;
    return first.at < second.at;
  };

  const leveled = placeSlices(graph, goesFirst, true, poolSizes);
  const projectFinish = Math.max(0, ...leveled.placed.map((each) => each.finish));
  // The augmented graph: the plan's edges and the ones the placement chose. A
  // slice held off by a person cannot slip without moving what that person does
  // next, so `float` and `critical` are only true of the plan that comes out if
  // they are computed over both.
  //
  // Proof: the backward pass run over the plan's successors alone and `counts
  // the person behind a slice as a reason it cannot slip` failed — a slice
  // whose assignee goes straight from it onto the critical path came back with
  // three days of slack it does not have, and no red; watched 2026-08-09.
  const queues = leveled.resourceSuccessors;
  const augmented = nodes.map((node, at) =>
    queues[at].length === 0 ? node.successors : [...node.successors, ...queues[at]],
  );
  const late = lateTimes(
    graph,
    leveled.order,
    augmented,
    projectFinish,
    leveled.placed,
    queues.some((next) => next.length > 0),
  );

  const scheduledSlices = new Map<string, ScheduledSlice>();
  const waiting = new Set<string>();
  const waitingOnSlots = new Set<string>();
  nodes.forEach((node, at) => {
    const { slice } = node;
    const placed = leveled.placed[at];
    const { latestStart, latestFinish } = late[at];
    const slack = slackOf(latestStart, placed.start);
    if (placed.boundBy === 'person') waiting.add(slice.workItemId);
    // Beside the person's count, never folded into it: "waiting for a person"
    // and "waiting for a slot" are different sentences, and `boundBy` names
    // exactly one of them for any slice.
    if (placed.boundBy === 'capacity') waitingOnSlots.add(slice.workItemId);
    scheduledSlices.set(node.key, {
      workItemId: slice.workItemId,
      roleId: slice.roleId,
      // What the block occupied, which is its effort divided among the people
      // on it. The same number as the effort at width 1, which is every slice
      // of every plan that sets no capacity field.
      duration: (slice.days ?? 0) / slice.width,
      effort: slice.days ?? 0,
      width: slice.width,
      // Proof: hard-coded to `true` and the captured live plan came back with
      // three of its rows claiming somebody had estimated them, along with
      // `reports an unestimated leaf as unestimated, not merely as zero` and
      // the parent above it; watched 2026-08-09.
      estimated: slice.days !== null,
      earliestStart: placed.start,
      earliestFinish: placed.finish,
      latestStart,
      latestFinish,
      float: slack,
      critical: slack === 0,
      personId: slice.personId,
      boundBy: placed.boundBy,
      resourcePredecessorId:
        placed.resourcePredecessor === NOBODY ? null : nodes[placed.resourcePredecessor].key,
      capacityPredecessorIds: placed.capacityPredecessors.map((blocker) => nodes[blocker].key),
      capacityTeamId: placed.capacityTeamId,
    });
  });

  const scheduleOf = (key: string): ScheduledSlice => {
    const found = scheduledSlices.get(key);
    if (found === undefined) throw new Error(`no schedule for slice ${key}`);
    return found;
  };
  return {
    slices: scheduledSlices,
    workItems: projectOntoWorkItems(rows, index, slicesOf, scheduleOf),
    waitingForPerson: waiting.size,
    waitingForCapacity: waitingOnSlots.size,
    eventsVisited: leveled.eventsVisited,
  };
}

/**
 * A work item's own schedule, read off the slices beneath it, and a parent's
 * span read off those.
 *
 * A leaf takes the earliest of its slices' starts, the latest of their
 * finishes, their total duration, and is estimated when any of them is.
 *
 * Its **slack is the least any of its slices has**, and it is critical when any
 * of them is — but where its slices **tile**, that least slack is read off the
 * projected endpoints instead. Tiling slices all carry the same float in
 * arithmetic and not in doubles: `(A + p) - (B + p)` differs from `A - B` for a
 * majority of pairs drawn from PERT finals, so taking the minimum would give a
 * row that has always had a slack of `0` a slack of `-1.1e-16` and a red row
 * where there was none. The endpoints are the first slice's own two numbers, so
 * reading them is the same answer with none of that noise.
 *
 * A work item stops tiling when a person pulled it apart — or, since the
 * anchor rule, whenever a successor's edge leaves a middle slice and splits
 * the late times with nobody assigned (design.md D5: the non-tiling arm is
 * ordinary now, not rare). Then the endpoints are not the answer at all: a row whose `QA` was held back until its assignee
 * came free has a critical `QA` and a slack `Dev`, and the difference of its
 * ends would report the slack of the `Dev` and no red.
 *
 * A parent spans the leaves beneath it, by the same rule and the same code as
 * before there were slices at all: effort and span are different numbers, and
 * two independent children of 3 and 4 days are 7 days of work in a 4-day branch.
 */
function projectOntoWorkItems(
  rows: readonly WorkItem[],
  index: TreeIndex,
  slicesOf: (workItemId: string) => WorkItemSlices,
  scheduleOf: (key: string) => ScheduledSlice,
): Map<string, Scheduled> {
  const isLeaf = new Set(index.leafIds);
  const projected = new Map<string, Scheduled>();
  for (const leafId of index.leafIds) {
    const own = slicesOf(leafId).slices.map((slice) =>
      scheduleOf(sliceKey(slice.workItemId, slice.roleId)),
    );
    const start = Math.min(...own.map((s) => s.earliestStart));
    const late = Math.min(...own.map((s) => s.latestStart));
    // Whether the slices tile: each one begins where the one before it ended,
    // early and late. That is exactly the condition under which the placement
    // kept one anchor for the whole work item, so the endpoints below are the
    // first slice's own numbers rather than a subtraction across a gap.
    const tiles = own.every(
      (s, at) =>
        at === 0 ||
        (s.earliestStart === own[at - 1].earliestFinish &&
          s.latestStart === own[at - 1].latestFinish),
    );
    // Proof: with `tiles` forced to `false`, so that tiling slices are
    // aggregated too, `answers what the previous engine answered` failed at
    // seed 256 — a row's slack of 12.333333333333332 became 12.33333333333333;
    // watched 2026-08-09. Forced to `true`, so that a work item a person pulled
    // apart is read off its ends, `reports the least slack of a work item whose
    // slices a person pushed apart` failed with a slack of 5 on a row holding a
    // critical slice.
    //
    // The aggregated side — a row pulled apart by a person or by an
    // anchor-split of its late times — needs no
    // {@link slackOf} of its own: every slice's float is snapped before it gets
    // here, and the least of snapped numbers is one of them. Its `critical` is
    // left as it was, read off the slices rather than off the aggregate, which
    // is that branch's own rule and not this change's to move.
    const slack = tiles ? slackOf(late, start) : Math.min(...own.map((s) => s.float));
    projected.set(leafId, {
      duration: own.reduce((sum, s) => sum + s.duration, 0),
      estimated: own.some((s) => s.estimated),
      earliestStart: start,
      earliestFinish: Math.max(...own.map((s) => s.earliestFinish)),
      latestStart: late,
      latestFinish: Math.max(...own.map((s) => s.latestFinish)),
      float: slack,
      critical: tiles ? slack === 0 : own.some((s) => s.critical),
    });
  }

  // A parent's span, not its total. Its rolled-up effort is a different number
  // and is reported separately.
  for (const row of rows) {
    if (isLeaf.has(row.id)) continue;
    const beneath = (index.leavesUnder.get(row.id) ?? [])
      .map((id) => projected.get(id))
      .filter((s): s is Scheduled => s !== undefined);
    const starts = beneath.map((s) => s.earliestStart);
    const finishes = beneath.map((s) => s.earliestFinish);
    const spanStart = Math.min(...starts, Infinity) === Infinity ? 0 : Math.min(...starts);
    // Proof: summed instead of maxed and two `parents` tests failed, reporting
    // a 4-day branch as 7 days long because that is its effort.
    const spanFinish = Math.max(0, ...finishes);
    projected.set(row.id, {
      duration: 0,
      estimated: beneath.some((s) => s.estimated),
      earliestStart: spanStart,
      earliestFinish: spanFinish,
      latestStart: Math.min(...beneath.map((s) => s.latestStart), spanStart),
      latestFinish: Math.max(0, ...beneath.map((s) => s.latestFinish)),
      float:
        Math.min(...beneath.map((s) => s.float), Infinity) === Infinity
          ? 0
          : Math.min(...beneath.map((s) => s.float)),
      // A branch is critical when anything inside it is: shortening that leaf
      // shortens the project, and the branch is where a reader looks first.
      critical: beneath.some((s) => s.critical),
    });
  }

  return projected;
}
