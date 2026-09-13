import { isWithin } from '@wbs/domain/is-within';

/** A work item as the dependency rule needs to see it: where it sits, and what it waits for. */
export interface GraphRow {
  id: string;
  parentId: string | null;
  /** The work items this one waits for, by id — one written edge each. */
  dependsOn: readonly string[];
}

/** A finish-to-start edge, as written: either end may be a parent. */
interface Edge {
  predecessorId: string;
  successorId: string;
}

/**
 * Why be-01 would refuse an edge, from the predecessor's side.
 *
 * `ancestor` is the predecessor containing the successor, `descendant` the
 * predecessor sitting inside it. be-01's `canDepend` answers `ancestor` to all
 * three of those and to `self` besides — one word is enough to say no with over
 * HTTP. The picker writes a different sentence under each, which is the only
 * difference between the two rules and is asserted as such in `dep-graph.test.ts`.
 */
export type EdgeRefusal = 'self' | 'ancestor' | 'descendant' | 'cycle';

/**
 * The project's tree and its edges, indexed once for a whole list of candidates.
 *
 * Built per render from the rows on screen and never cached: a refetch can move
 * a row under a parent or land a peer's new edge while the picker is open, and a
 * remembered graph would go on greying yesterday's rows.
 */
export interface DepGraph {
  /** Every id in this project, so an end that names no row can be caught. */
  ids: Set<string>;
  parentOf: Map<string, string | null>;
  /** Every work item with no children — the only nodes the schedule orders. */
  leafIds: string[];
  /** For any id: the leaves beneath it. A leaf maps to itself. */
  leavesUnder: Map<string, string[]>;
  /** The written edges, already expanded to leaf pairs. */
  leafEdges: Edge[];
}

/**
 * The rows and their `dependsOn`, turned into the graph be-01 judges an edge
 * against.
 *
 * A port of `indexTree` + `expandToLeaves` in `apps/libs/domain/src/schedule.ts`,
 * down to what it does with an id it has no row for: `expandToLeaves` reads that
 * end as no leaves and contributes nothing, so this does too. Refusing more than
 * be-01 refuses would grey out a row the server would have accepted, which is
 * the same lie as offering one it will reject, told the other way round.
 */
export function indexDepGraph(rows: readonly GraphRow[]): DepGraph {
  const childrenOf = new Map<string, GraphRow[]>();
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

  const graph: DepGraph = {
    ids: new Set(rows.map((row) => row.id)),
    parentOf: new Map(rows.map((row) => [row.id, row.parentId])),
    leafIds: rows.filter((row) => !childrenOf.has(row.id)).map((row) => row.id),
    leavesUnder,
    leafEdges: [],
  };

  const written = rows.flatMap((row) =>
    row.dependsOn.map((predecessorId) => ({ predecessorId, successorId: row.id })),
  );
  graph.leafEdges = expandToLeaves(graph, written);
  return graph;
}

/** Every pair of leaves the written edges imply — the graph the schedule is ordered over. */
function expandToLeaves(graph: DepGraph, edges: readonly Edge[]): Edge[] {
  const isLeaf = new Set(graph.leafIds);
  const expanded: Edge[] = [];
  for (const { predecessorId, successorId } of edges) {
    for (const from of graph.leavesUnder.get(predecessorId) ?? []) {
      if (!isLeaf.has(from)) continue;
      for (const to of graph.leavesUnder.get(successorId) ?? []) {
        if (isLeaf.has(to)) expanded.push({ predecessorId: from, successorId: to });
      }
    }
  }
  return expanded;
}

/**
 * Kahn's algorithm over the leaf graph, answering the one question `hasCycle`
 * asks by catching the schedule's throw.
 *
 * A boolean rather than a throw because nothing here computes a schedule: fe-01
 * only ever wants the yes or no, and be-01's `topological` throws so that a
 * schedule can never be built from a cycle.
 */
function canOrder(leafIds: readonly string[], edges: readonly Edge[]): boolean {
  const incoming = new Map(leafIds.map((id) => [id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const { predecessorId, successorId } of edges) {
    const group = outgoing.get(predecessorId);
    if (group === undefined) outgoing.set(predecessorId, [successorId]);
    else group.push(successorId);
    incoming.set(successorId, (incoming.get(successorId) ?? 0) + 1);
  }

  const ready = leafIds.filter((id) => incoming.get(id) === 0);
  let ordered = 0;
  while (ready.length > 0) {
    const id = ready.shift();
    if (id === undefined) break;
    ordered += 1;
    for (const next of outgoing.get(id) ?? []) {
      const left = (incoming.get(next) ?? 0) - 1;
      incoming.set(next, left);
      if (left === 0) ready.push(next);
    }
  }
  return ordered === leafIds.length;
}

/**
 * Why be-01 would refuse this edge, or `null` when it would write it.
 *
 * A prediction, not a decision: be-01's `canDepend` is still the authority and
 * is untouched: this exists so the picker can grey out a click that would come
 * back an error, and it is a port of that function rather than a second opinion.
 * The one thing it says that be-01 does not is which way round an ancestor edge
 * runs — see {@link EdgeRefusal}.
 *
 * The cycle question is asked of the **expanded** graph, because that is the
 * graph the schedule is built over: an edge declared on a parent means every
 * leaf beneath it, and asking the written edges instead accepts an edge whose
 * expansion closes a loop. be-01 learned that from two reviewers; the same
 * cases are in `dep-graph.test.ts`.
 *
 * @throws when either end names no row of `graph`. be-01 answers `not_found`
 *   there because it takes ids off the wire; both ends here come out of the rows
 *   the caller was handed, so an unknown one is a caller bug (R5).
 */
export function refusalFor(graph: DepGraph, edge: Edge): EdgeRefusal | null {
  const { predecessorId, successorId } = edge;
  for (const id of [predecessorId, successorId]) {
    if (!graph.ids.has(id)) throw new Error(`no work item ${id} in this project`);
  }

  if (predecessorId === successorId) return 'self';
  // A parent already spans its children, so asking it to wait for one is asking
  // it to start after itself — and the same the other way up.
  // Proof: the two calls swapped and `says which way round an ancestor edge
  // runs` failed, naming a parent as sitting inside its own child.
  if (isWithin(graph.parentOf, successorId, predecessorId)) return 'ancestor';
  if (isWithin(graph.parentOf, predecessorId, successorId)) return 'descendant';

  // Proof: `expandToLeaves` here replaced by the written edge, and the four
  // expansion cases failed — the two cross-review examples among them.
  const proposed = expandToLeaves(graph, [edge]);
  if (!canOrder(graph.leafIds, [...graph.leafEdges, ...proposed])) return 'cycle';

  return null;
}
