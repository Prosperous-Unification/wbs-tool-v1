import { type EffectiveSet, effectiveSetOf } from '@wbs/domain';

import type { Assignment, DirectoryUsageRows, WorkItem } from '../repository';
import { assumedAssignee } from './assumed-assignee';
import { deriveNumbers } from './derive-numbers';

/**
 * What removing a directory entry would do to one work item.
 *
 * Each arm names its kind **and what that kind does**, rather than a count a
 * reader would have to interpret: `label_nulled` says the label goes, and
 * `assumed_assignee_changed` says who the work reads as belonging to now and
 * who it would read as after.
 */
export type DirectoryEffect =
  | { kind: 'assignment_dropped'; role: { id: string; name: string } }
  | { kind: 'label_nulled' }
  | {
      /**
       * The team was **sized**, and this row's work draws slots from it — so
       * the removal takes a capacity constraint away and this row's dates move
       * with it.
       *
       * Beside `label_nulled` rather than folded into it, and on rows that
       * carry no label of their own: a leaf under a labelled parent inherits
       * the pool, holds no label to null, and its dates move exactly as the
       * labelled row's do. A confirmation that listed only the labelled rows
       * would show one row and move twenty.
       */
      kind: 'capacity_released';
      /** How many of the team may be at work at once today — the bound that goes. */
      size: number;
      /**
       * The row whose label puts this one on the pool: this row itself, or the
       * nearest ancestor above it that carries the team.
       *
       * Equal to the row's own id exactly when the label is its own, so the
       * payload never says "inherited" twice — once here and once as a flag
       * beside it.
       */
      fromId: string;
    }
  | {
      kind: 'assumed_assignee_changed';
      /**
       * The **assumed assignee**'s name, or `null` — and `null` means
       * `unassigned`. A removal that takes a work item's sole assignee names
       * the flip rather than leaving it to be inferred from an absence.
       */
      assumedNow: string | null;
      assumedAfter: string | null;
    };

/** One work item a removal would touch, named as the plan shows it. */
export interface UsedWorkItem {
  id: string;
  /** The derived number the plan shows — `3.1`, not a row index. */
  number: string;
  name: string;
  effects: DirectoryEffect[];
}

export interface UsedProject {
  id: string;
  name: string;
  workItems: UsedWorkItem[];
}

/**
 * **Directory usage**: what removing a person or a team would take with it,
 * named rather than counted.
 *
 * Both halves are always present and never optional. A caller reading
 * `usage.members` has to be able to tell "nobody" from "this payload does not
 * say", and an absent key says the second while meaning the first.
 */
export interface DirectoryUsage {
  projects: UsedProject[];
  members: { id: string; name: string }[];
}

/** Who a work item's assignments name, keyed by role. */
function byRoleOn(assignments: readonly Assignment[], workItemId: string): Record<string, string> {
  const held: Record<string, string> = {};
  for (const each of assignments) {
    if (each.workItemId === workItemId) held[each.roleId] = each.personId;
  }
  return held;
}

/**
 * The usage assembled from `rows`, keeping only the work items `effectsOf`
 * found something to say about.
 *
 * Sorted — projects by name, work items by their derived number — because a
 * confirmation that lists the same impact in a different order each time reads
 * as a different answer.
 *
 * Proof: with the per-project grouping removed and every project's rows handed
 * to `deriveNumbers` at once, `names both projects a team is labelled in` fails
 * — the second project's only work item was named `020`, which is the number a
 * combined tree gives it and no screen anywhere shows. Watched 2026-08-09.
 */
function usageFrom(
  rows: DirectoryUsageRows,
  effectsOf: (row: WorkItem) => DirectoryEffect[],
): DirectoryUsage {
  // Per project, never across them. `deriveNumbers` numbers one tree, and two
  // projects' roots handed to it in one array become one numbering: the second
  // project's first row reads `020`, which is a number nobody's screen shows.
  const treeOf = new Map<string, WorkItem[]>();
  for (const row of rows.workItems) {
    treeOf.set(row.projectId, [...(treeOf.get(row.projectId) ?? []), row]);
  }
  const numbers = new Map<string, string>();
  for (const tree of treeOf.values()) {
    for (const [id, number] of deriveNumbers(tree)) numbers.set(id, number);
  }
  const byProject = new Map<string, UsedWorkItem[]>();
  for (const row of rows.workItems) {
    const effects = effectsOf(row);
    if (effects.length === 0) continue;
    const number = numbers.get(row.id);
    // Every work item here came out of the same read the numbers were derived
    // from, so a missing one is not a state to default past.
    if (number === undefined) throw new Error(`${row.id} was not numbered by its own project`);
    byProject.set(row.projectId, [
      ...(byProject.get(row.projectId) ?? []),
      { id: row.id, number, name: row.name, effects },
    ]);
  }
  const projects = rows.projects
    .filter((each) => byProject.has(each.id))
    .map((each) => ({
      id: each.id,
      name: each.name,
      workItems: (byProject.get(each.id) ?? []).sort((a, b) => (a.number < b.number ? -1 : 1)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { projects, members: rows.members.map((each) => ({ id: each.id, name: each.name })) };
}

/**
 * The directory usage of one person: the assignments that hold them, and every
 * work item whose **assumed assignee** would move once those assignments went.
 *
 * The flip is derived through {@link assumedAssignee} rather than written out
 * again, so the reading a confirmation shows and the reading the tree reports
 * cannot drift — a drift here would name the wrong people in a confirmation
 * somebody is about to agree to.
 */
export function directoryUsageOfPerson(rows: DirectoryUsageRows, personId: string): DirectoryUsage {
  const nameOf = new Map(rows.people.map((each) => [each.id, each.name]));
  const roleOf = new Map(rows.roles.map((each) => [each.id, each.name]));
  return usageFrom(rows, (row) => {
    const held = byRoleOn(rows.assignments, row.id);
    const dropped = Object.entries(held).filter(([, personOf]) => personOf === personId);
    if (dropped.length === 0) return [];
    const effects: DirectoryEffect[] = dropped
      .map(([roleId]) => roleId)
      .sort()
      .map((roleId) => ({
        kind: 'assignment_dropped' as const,
        role: { id: roleId, name: roleOf.get(roleId) ?? '' },
      }));
    const left = Object.fromEntries(
      Object.entries(held).filter(([, personOf]) => personOf !== personId),
    );
    const now = assumedAssignee(held);
    const after = assumedAssignee(left);
    if (now !== after) {
      effects.push({
        kind: 'assumed_assignee_changed',
        assumedNow: now === null ? null : (nameOf.get(now) ?? null),
        assumedAfter: after === null ? null : (nameOf.get(after) ?? null),
      });
    }
    return effects;
  });
}

/**
 * The directory usage of one team: every work item labelled with it, every work
 * item that **inherits** it while the team is sized, and every person who
 * belongs to it.
 *
 * No assignment moves — a team labels the work and a person does it, and the
 * two are deliberately unconnected — so `label_nulled` is the only effect an
 * **unsized** team's removal has on a work item.
 *
 * A **sized** team's removal does more, and this is where that is said out
 * loud: the size is a pool every one of its slices draws slots from, so taking
 * the team away lets that work run as wide as it likes and moves dates through
 * the whole labelled subtree. The rows that inherit the label carry no label to
 * null and would otherwise not appear in the confirmation at all, which is why
 * `effectiveSetOf` is read here rather than each row's own set alone.
 *
 * The reading is {@link effectiveSetOf}'s and nobody's second copy — the same
 * function the scheduler's adapter resolves `poolId` through — so a row named
 * here is a row the scheduler agrees draws from that pool, rather than one a
 * second, laxer definition of "in the team" turned up.
 *
 * What this is **not** is the set of rows whose dates move, and it drifts from
 * that set both ways. A parent labelled with the sized team whose children each
 * carry their own is named — `effectiveSetOf` answers for parents too — and
 * moves nothing, because `slicesOf` skips a row with children, so no slot of
 * that pool was ever spent on it. And releasing a pool moves the dependency
 * successors of the released rows and the rolled-up brackets of every ancestor
 * above them; those have a different effective team and get no effect. Each
 * entry says "this row drew from a pool that is going", which is the fact
 * somebody agreeing to the removal needs and the fact the read can carry.
 *
 * Proof: the effective-set read replaced by "the row's own set holds it", so
 * only rows carrying the label themselves are named, and `names the capacity a
 * sized team takes with it, inherited rows included` failed — the inheriting
 * leaf `API` vanished from the confirmation entirely, leaving somebody
 * agreeing to one row and moving two.
 *
 * Proof: the null-size arm replaced by a default of 1, so every team's removal
 * claims a capacity effect, and `says nothing about capacity when the team was
 * never sized` failed — an unsized team's removal reported
 * `capacity_released, size: 1` on two rows whose dates cannot move at all,
 * which is a confirmation lying in the other direction. Both watched
 * 2026-08-12.
 *
 * **The number is each row's own project's**, since `capacity-per-project`: the
 * same team may be stated at four on one plan and unstated on the next, and one
 * number for the whole confirmation would name a bound half the rows it printed
 * on were never under.
 *
 * Proof: the per-project lookup replaced by "any project stated something"
 * (`[...rows.capacityOf.values()].at(0)`), and `names each project's own
 * capacity, and says nothing where a project stated none` failed — the second
 * project's rows carried `capacity_released, size: 4` for a plan that has no
 * pool at all. Watched 2026-08-13.
 *
 * That test was **missing** when this comment was first written, and the
 * injection above left all 693 be-01 tests green: the three other capacity
 * tests here use a single-project fixture, where `capacityOf` holds one entry
 * and `.at(0)` is the per-project answer by accident. The cross-review of PR #58
 * caught it. The proof above is the run against the test as it now stands.
 */
export function directoryUsageOfTeam(rows: DirectoryUsageRows, teamId: string): DirectoryUsage {
  // A project that has stated nothing for this team is *unstated*, and an
  // unstated pair bounds nothing: removing the team moves no date there, so there
  // is no capacity effect to name. Read off `capacityOf` rather than guessed from
  // the work items, which cannot tell the two apart.
  //
  // Computed once for every project rather than per project, because
  // `effectiveSetOf` walks `parentId` and a parent never leaves its project —
  // so one pass over all the rows answers for each of them.
  const inForce: ReadonlyMap<string, EffectiveSet> =
    rows.capacityOf.size === 0
      ? new Map()
      : effectiveSetOf(rows.workItems, (row) => rows.teamIdsOf.get(row.id) ?? []);
  return usageFrom(rows, (row) => {
    // The row's **own** set, not its effective one: `label_nulled` is about a
    // label this row carries and would lose, and an inheriting row loses
    // nothing of its own. The effective reading below is the other question.
    const effects: DirectoryEffect[] = (rows.teamIdsOf.get(row.id) ?? []).includes(teamId)
      ? [{ kind: 'label_nulled' }]
      : [];
    const size = rows.capacityOf.get(row.projectId);
    const effective = inForce.get(row.id);
    if (size !== undefined && effective?.memberIds.includes(teamId) === true) {
      effects.push({ kind: 'capacity_released', size, fromId: effective.fromId });
    }
    return effects;
  });
}
