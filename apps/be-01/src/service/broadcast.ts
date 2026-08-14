import type { Role } from '../repository';
import type { NumberedWorkItem } from './work-item.service';

/**
 * What subscribers to `project:<id>` receive.
 *
 * Two shapes rather than one for the work items, because they cost differently.
 * A cell edit touches one work item and its ancestors' totals, and that is a
 * small patch worth computing. A structural change can renumber a large slice of
 * the project — every sibling after an insertion, every child of a repadded
 * parent — and working out the minimal set is fiddly code that would be wrong in
 * rare cases. A work breakdown is hundreds of rows and structural edits are
 * rare, so sending the tree is the cheaper mistake.
 *
 * The three role events carry the role and **not** the tree, even though
 * removing one deletes estimates from it. A client reads the project's roles and
 * its tree together — one refresh, both reads — so a role event says which fact
 * moved and the client rereads both. Putting the tree in here would send a
 * second copy of it that the reader would have to reconcile with the roles it
 * has not read yet.
 */
export type ProjectEvent =
  | { type: 'work_items_changed'; workItems: NumberedWorkItem[] }
  | { type: 'tree_replaced'; workItems: NumberedWorkItem[] }
  | { type: 'role_added'; role: Role }
  | { type: 'role_renamed'; role: Role }
  | { type: 'role_removed'; roleId: string }
  /**
   * Something in the global directory that this project reads has changed — a
   * person or team renamed, or one removed and its assignments and labels taken
   * with it.
   *
   * It carries nothing, deliberately. The directory is global and a project
   * reads its people and teams alongside its tree on every refresh, so the only
   * useful thing to say is "read again". A payload would be a second copy of a
   * list the client is about to fetch anyway, and it would have to be
   * reconciled against the tree it has not fetched yet — the same argument the
   * three role events make for carrying the role and not the tree.
   */
  | { type: 'directory_changed' }
  /**
   * How many of a team this project may have at work at once has changed, so
   * every date in it may have moved.
   *
   * It carries nothing, for `directory_changed`'s reason: a client reads the
   * project's capacities alongside its tree on every refresh, so the only useful
   * thing to say is "read again".
   *
   * Its **own** type rather than `directory_changed`, and the reason is that the
   * name has to be true. `directory_changed` says "something in the global
   * directory that this project reads has changed", and a per-project capacity is
   * not in the directory at all — the same distinction that makes this write fan
   * out to one project where C2's global size fanned out to every project the
   * team labelled. C2 folded a proposed `team_capacity_set` into
   * `directory_changed` because the directory row really did change; here it does
   * not.
   *
   * The choice costs nothing on the wire: fe-01 treats every project event as
   * "read again" and does not read the type, so it is decided purely on whether
   * a reader of this union is told the truth. See
   * `openspec/changes/capacity-per-project/design.md` D6.
   */
  | { type: 'capacity_changed' }
  /**
   * What this project calls its priority numbers has changed — a rung renamed,
   * a cut moved, or a default re-pointed.
   *
   * **No date moved**, and that is the one thing this event is unlike every
   * other in the union about. The ladder is read by no scheduling code; a client
   * rereads because the labels and the colours on its table, its chart, its
   * cards and its export are all drawn from it, and a plan open on a second
   * screen would otherwise go on painting `High` over a rung that now says
   * `Blocker`.
   *
   * Its own type rather than `capacity_changed` or `directory_changed`, for the
   * reason C5's D6 gives: fe-01 reads every project event as "read again" and
   * never inspects the type, so the name costs nothing either way and is
   * therefore decided purely on whether a reader of this union is told the
   * truth.
   */
  | { type: 'priority_bands_changed' };

/**
 * The subscription name carrying a project's edits.
 *
 * One function rather than a template literal at each call site: be-01 records
 * events under this name, gw-01 matches sockets against it, and fe-01 subscribes
 * with it. Three spellings of the same string is a silent no-op, not an error.
 */
export function subscriptionFor(projectId: string): string {
  return `project:${projectId}`;
}

export interface Broadcaster {
  publish(projectId: string, event: ProjectEvent): Promise<void>;
  /**
   * Where the project's event stream has reached, or `-1` for a project that has
   * never been edited.
   *
   * It lives on the broadcaster rather than on a second collaborator because the
   * broadcaster is what advances the sequence; a reader that asked something else
   * could be told a number the publisher had already moved past.
   */
  latestSeq(projectId: string): Promise<number>;
}

/** The work item and every ancestor above it, whose roll-ups its change moved. */
export function withAncestors(
  workItems: readonly NumberedWorkItem[],
  id: string,
): NumberedWorkItem[] {
  const byId = new Map(workItems.map((w) => [w.id, w]));
  const chain: NumberedWorkItem[] = [];
  // `string | null`, not `| undefined`: a parentId is null at the root and never
  // absent. The `byId` lookup below is the one that can genuinely miss.
  let cursor: string | null = id;
  while (cursor !== null) {
    const found = byId.get(cursor);
    if (found === undefined) break;
    chain.push(found);
    cursor = found.parentId;
  }
  return chain;
}
