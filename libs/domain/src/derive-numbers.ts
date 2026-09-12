import { siblingGroupsOf, type TreePlacement } from './tree-order';

/** The placement facts a work item is numbered from. */
export interface WorkItemPlacement extends TreePlacement {
  frozenNumber: string | null;
}

/**
 * The labels one sibling group takes, in position order.
 *
 * Roots read `010`, `020`, `030` — leading zero so `010` sorts before `100`,
 * trailing zero so `011` can be inserted later without disturbing either
 * neighbour. Children read `1`, `2`, `3` and are joined to their parent's number
 * with a dot.
 *
 * Both widen by the same rule, and the rule exists because the sort is
 * byte-wise: at ten children `010.10` would otherwise sort second, between
 * `010.1` and `010.2`. Width is whatever the highest label needs, so a tenth
 * child takes the whole group to `010.01`–`010.10` and a hundredth root takes
 * every root to `0010`–`1000`.
 */
function labelsFor(count: number, isRoot: boolean): string[] {
  const step = isRoot ? 10 : 1;
  const highest = count * step;
  // Roots never drop below three characters: `010` is the agreed shape even
  // when a project holds one work item.
  const width = isRoot ? Math.max(3, String(highest).length) : String(highest).length;
  return Array.from({ length: count }, (_, i) => String((i + 1) * step).padStart(width, '0'));
}

/** The last segment of a number — the part that belongs to one sibling group. */
function labelOf(number: string, isRoot: boolean): string {
  if (isRoot) return number;
  const segments = number.split('.');
  return segments[segments.length - 1] ?? number;
}

/**
 * Every work item's number, keyed by id.
 *
 * Pure, and given the whole project at once, because a number is a fact about a
 * work item's place among its siblings rather than about the work item. It reads
 * only `parentId`, `position` and `frozenNumber` and never a number it
 * previously produced, so a wrong number is repaired by running this again —
 * which is what makes deleting a work item safe to follow with a plain
 * re-derivation.
 *
 * **A `frozenNumber` is reported verbatim, and the unfrozen siblings step
 * around it** (ADR 0023). Each group's natural labels are computed from its
 * size; the unfrozen work items take them in position order, skipping any label
 * a frozen sibling already holds as its last segment. Nothing is fitted
 * between* frozen labels any more — the old walk built `0105` to sit between
 * `010` and `011`, which kept a byte-wise sort equal to tree order but only
 * while frozen labels ascended along position, and a frozen work item may move
 * now. {@link treeOrder} is that order's spelling instead, and a number in a
 * group where a frozen work item has moved no longer says where its row sits.
 *
 * **What survives is that no two siblings share a label**, and it survives by
 * counting rather than by searching: a group of *n* has exactly *n* natural
 * labels, its frozen work items hold at most *n* distinct labels between them,
 * and they consume a natural only when one of theirs *is* a natural — so the
 * free naturals never number fewer than the unfrozen work items.
 *
 * @throws if a work item is not reachable from any root — an orphan, or a
 * parent cycle. Returning the reachable ones would hand back a project silently
 * missing rows, and a cycle would not even return.
 */
export function deriveNumbers(placements: readonly WorkItemPlacement[]): Map<string, string> {
  const groups = siblingGroupsOf(placements);

  const numbers = new Map<string, string>();
  const numberGroup = (parentId: string | null, parentNumber: string | null): void => {
    const group = groups.get(parentId) ?? [];
    const isRoot = parentNumber === null;
    const held = new Set(
      group.flatMap((each) =>
        each.frozenNumber === null ? [] : [labelOf(each.frozenNumber, isRoot)],
      ),
    );
    const free = labelsFor(group.length, isRoot).filter((label) => !held.has(label));

    let claimed = 0;
    for (const placement of group) {
      let number: string;
      if (placement.frozenNumber === null) {
        // `.at` rather than `[]`, for the reason `external-system.ts` records:
        // this project's tsconfig has no `noUncheckedIndexedAccess`, so a
        // bracket index is typed as always present and the guard below reads as
        // dead code to both the compiler and `no-unnecessary-condition` — which
        // is what it reported, here, on the first draft of this line.
        const label = free.at(claimed);
        // Unreachable by the counting argument in this function's JSDoc, and a
        // throw rather than a fallback because a label this code could not
        // produce becomes the string `undefined` on somebody's exported ticket.
        //
        // Proof: `labelsFor` made to return `labels.slice(1)`, so a group is one
        // label short — `numbers roots in tens` failed on `error: a sibling
        // group of 3 ran out of labels`, which is this line; watched
        // 2026-09-11, then restored.
        if (label === undefined) {
          throw new Error(`a sibling group of ${String(group.length)} ran out of labels`);
        }
        claimed += 1;
        number = parentNumber === null ? label : `${parentNumber}.${label}`;
      } else {
        // A stored number is reported exactly as it was written down, never
        // rebuilt from the current parent. Rebuilding is how a frozen `010.1.1`
        // became `010.1` when its parent was promoted — colliding with a frozen
        // sibling and pointing one exported ticket number at two work items.
        number = placement.frozenNumber;
      }
      numbers.set(placement.id, number);
      numberGroup(placement.id, number);
    }
  };
  numberGroup(null, null);

  // Every work item must have been reached. One that was not is either an
  // orphan — its `parentId` names a work item outside this project — or part of
  // a parent cycle, and both mean the caller is holding something that is not a
  // tree. Returning the reachable ones would hand back a project silently
  // missing rows, and a cycle would not even return.
  if (numbers.size !== placements.length) {
    const unreachable = placements.filter((p) => !numbers.has(p.id)).map((p) => p.id);
    throw new Error(`work items unreachable from any root: ${unreachable.join(', ')}`);
  }

  return numbers;
}

/**
 * What the scheduler reads off a work item: where it sits, and how it ranks.
 *
 * `apps/libs/domain/src/schedule.ts` is 2,200 lines of pure planning that
 * imported one type from the storage barrel and used it for this and nothing
 * else. Declaring what it needs — rather than the row it happened to be handed —
 * is what lets the engine live beside the rules it already shares
 * (`snapWorkdays`, `ASSUMED_SLICE_WORKDAYS`, `DependencyReach`) instead of on
 * the far side of a repository.
 *
 * **Extends {@link WorkItemPlacement} rather than restating three fields.** The
 * engine numbers the rows it schedules — `schedule.ts` calls
 * {@link deriveNumbers} on the way past — so it needs everything numbering
 * needs, plus the priority the leveller ranks by. The first draft named `id`,
 * `parentId` and `priority` alone and the compiler refused it on exactly that
 * call.
 *
 * `WorkItem` satisfies this structurally, so every caller keeps passing the rows
 * it already has and nothing maps anything.
 */
export interface PlannedRow extends WorkItemPlacement {
  priority: number | null;
}
