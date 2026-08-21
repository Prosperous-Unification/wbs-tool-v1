import { type EffectiveTeams, effectiveTeamsOf } from '@wbs/domain';

import type { Assignment, DirectoryUsageRows, LabelledWorkItem } from '../repository';
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
  /**
   * The row carries the tag being removed, and will stop carrying it.
   *
   * Its own kind rather than `label_nulled`, because nothing is nulled: a tag
   * has no column on `work_item` to set to null. The labelling **is** a row in
   * `work_item_tag`, and what goes is that row — which is also why the delete
   * needs no explicit clear, the cascade takes it.
   *
   * It carries no size and has no `capacity_released` beside it, ever. Removing
   * a tag moves no date in any plan; the row stops being findable under that
   * facet and that is the whole of the effect.
   */
  | { kind: 'label_removed' }
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
  effectsOf: (row: LabelledWorkItem) => DirectoryEffect[],
): DirectoryUsage {
  // Per project, never across them. `deriveNumbers` numbers one tree, and two
  // projects' roots handed to it in one array become one numbering: the second
  // project's first row reads `020`, which is a number nobody's screen shows.
  const treeOf = new Map<string, LabelledWorkItem[]>();
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
 * What removing one **tag** would take with it: the labelling, and nothing else.
 *
 * **Two arms shorter than {@link directoryUsageOfTeam}, and the absences are the
 * whole point of the function.**
 *
 * No `capacity_released`, because a tag has no pool: there is no `size` on the
 * table and no per-project capacity beside it, so there is nothing a removal
 * could give back. No inherited arm either, and that is the subtler one — a team
 * removal names rows that carry no label of their own, because an inherited pool
 * moves their dates. Losing an inherited **tag** moves nothing: the row stops
 * being findable under that facet and every date it has stays exactly where it
 * was. So this names the rows that actually carry the tag, and no others.
 *
 * `label_removed` rather than `label_nulled`, because nothing is nulled — there
 * is no column. A row's tags are rows in `work_item_tag`, and what a cascade
 * takes is the row.
 *
 * **No date in this payload moves.** That is asserted rather than stated: a test
 * schedules a plan, deletes a tag with `?cascade=1`, schedules it again and
 * compares every date. See `tags`' verify.md.
 *
 * Membership is read off the row's **own** set, for the reason the team version
 * argues at length: a work item carrying two tags loses one per removal, and a
 * reader of `tagIds[0]` would report nothing at all for the second of them.
 */
export function directoryUsageOfTag(rows: DirectoryUsageRows, tagId: string): DirectoryUsage {
  return usageFrom(rows, (row) => (row.tagIds.includes(tagId) ? [{ kind: 'label_removed' }] : []));
}

/**
 * What removing one **service** would take with it: the label, and nothing else.
 *
 * `label_removed` rather than `label_nulled`, and the difference is literal:
 * since task 10.2 this dimension is a join table and not a column, so what
 * happens to a row that names the service is that one `work_item_service` row
 * goes — the tag's effect exactly, and spelled its way for the same honesty.
 *
 * It said `label_nulled` until 10.2 and that was true while the column was
 * authoritative, which is why the correction waited for this task rather than
 * shipping with the table in 10.1: a row carrying two services loses one member
 * and keeps the other, and "nulled" describes a row that lost the lot.
 *
 * **No `capacity_released` arm**, for {@link directoryUsageOfTag}'s reason: a
 * service has no pool, no size and no per-project capacity, so there is nothing
 * a removal could give back. No inherited arm either — losing an inherited
 * service moves no date, so the rows that only inherit it are not named. Both
 * absences are the model rule, and a service that grew a pool would have to
 * change this function to ship.
 *
 * Read off the row's own set and never `effectiveServicesOf`: the confirmation
 * names the rows the removal writes to, which is exactly the rows that state it,
 * and an inherited service is stated by an ancestor rather than by the row.
 *
 * The `team_service` rows the removal also takes are **not** here. An ownership
 * claim about a service that no longer exists is not an effect on any plan, and
 * a confirmation listing it would ask somebody to weigh a fact that goes with
 * its own subject (design.md D7).
 */
export function directoryUsageOfService(
  rows: DirectoryUsageRows,
  serviceId: string,
): DirectoryUsage {
  return usageFrom(rows, (row) =>
    row.serviceIds.includes(serviceId) ? [{ kind: 'label_removed' }] : [],
  );
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
 * `effectiveTeamOf` is read here rather than `serviceTeamId` alone.
 *
 * The reading is {@link effectiveTeamOf}'s and nobody's second copy — the same
 * function the scheduler's adapter resolves `poolId` through — so a row named
 * here is a row the scheduler agrees draws from that pool, rather than one a
 * second, laxer definition of "in the team" turned up.
 *
 * What this is **not** is the set of rows whose dates move, and it drifts from
 * that set both ways. A parent labelled with the sized team whose children each
 * carry their own is named — `effectiveTeamsOf` answers for parents too — and
 * moves nothing, because `slicesOf` skips a row with children, so no slot of
 * that pool was ever spent on it. And releasing a pool moves the dependency
 * successors of the released rows and the rolled-up brackets of every ancestor
 * above them; those have a different effective team and get no effect. Each
 * entry says "this row drew from a pool that is going", which is the fact
 * somebody agreeing to the removal needs and the fact the read can carry.
 *
 * Proof: the effective-team read replaced by the row's own label (then
 * `row.serviceTeamId === teamId`, now its own set), so
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
  // `effectiveTeamsOf` walks `parentId` and a parent never leaves its project —
  // so one pass over all the rows answers for each of them.
  const inForce: ReadonlyMap<string, EffectiveTeams> =
    rows.capacityOf.size === 0 ? new Map() : effectiveTeamsOf(rows.workItems);
  return usageFrom(rows, (row) => {
    // Membership of the row's **own** set, not its first member: a work item
    // labelled with two teams loses one label per removal, and a reader of
    // `teamIds[0]` would report nothing at all for the second of them.
    //
    // Proof: both membership tests here narrowed to `teamIds.at(0) === teamId`
    // and `names a work item labelled with the team, whichever member of its
    // set it is` failed on `+ []` — a confirmation saying nothing points at a
    // team it is about to unlabel — with `releases the capacity of an inherited
    // set, on either member` failing beside it; watched 2026-08-14.
    const effects: DirectoryEffect[] = row.teamIds.includes(teamId)
      ? [{ kind: 'label_nulled' }]
      : [];
    const size = rows.capacityOf.get(row.projectId);
    const effective = inForce.get(row.id);
    if (size !== undefined && effective?.teamIds.includes(teamId) === true) {
      effects.push({ kind: 'capacity_released', size, fromId: effective.fromId });
    }
    return effects;
  });
}
