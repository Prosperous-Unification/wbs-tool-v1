import type { ProjectStore, Role, RoleStore, RoleUsageRows } from '../repository';
import { type AssumedAssigneeFlip, assumedAssigneeFlips } from './assumed-assignee';
import type { Broadcaster } from './broadcast';
import { canEdit } from './project.service';

export interface RoleServiceOptions {
  projects: ProjectStore;
  roles: RoleStore;
  /**
   * Required, like the work item service's. A role service built without one
   * would change what every estimate in a project means and tell nobody — every
   * other client would keep drawing a column for a role that has gone until
   * somebody reloaded.
   */
  broadcast: Broadcaster;
  newId?: () => string;
}

/** Why a role could not be added or renamed. All four are states, not faults. */
export type RoleRefusal = 'not_found' | 'forbidden' | 'name_required' | 'taken';

export type RoleOutcome = { ok: true; result: Role } | { ok: false; reason: RoleRefusal };

/** What a removal would take with it, as the refusal reports it. */
export interface RoleInUse {
  estimates: number;
  /**
   * Days already recorded against this role — a count of rows, not a sum of
   * days.
   *
   * Reported separately from the estimates because the two are different losses:
   * an estimate is a guess that can be made again, and an actual is a record of
   * work that happened and cannot. A client that only knows how to say
   * "N estimates" is not wrong about this number, it is silent about it, which is
   * why the count travels even before a face reads it — H3's row in
   * `notes/wbs-brief-2026-08-14-r5-r6-history.md` §6.
   */
  actuals: number;
  /**
   * Work items that have said where this role's work has got to — a count of
   * rows, for {@link RoleInUse.actuals}' reason and in its tense.
   *
   * Reported separately again because it is a third kind of loss: an estimate is
   * a guess that can be made again, an actual is a record of a week, and a state
   * is somebody's statement that the work is finished. A removal that took one
   * silently would turn done work back into work nobody has started.
   */
  progress: number;
  /**
   * Figures this role holds in the units that are not days — a count of
   * **rows**, so a pair holding a token estimate and an hours fact counts two.
   *
   * A fourth kind of loss, reported separately for the three above's reason: an
   * estimate is a guess that can be made again, a recorded day and a recorded
   * hour are accounts of time that was spent, and a token figure is what a
   * plan's agent work cost. Rows rather than pairs because each metric is a
   * separate statement — see `RoleUsageRows.measures` in `repository/index.ts`.
   *
   * Travels before any face reads it, for {@link RoleInUse.actuals}' reason:
   * `fe-01`'s `RoleUsage` names estimates and assignments only, and has been
   * silent about `actuals` and `progress` since they landed. Widening that
   * sentence is a face change and belongs to a chunk that gates `fe-01`.
   */
  measures: number;
  /** Explicit assignments on this role. The assumed ones are in `assumedAssignees`. */
  assignments: number;
  /**
   * Every work item whose assumed assignee the removal would change — nobody
   * wrote those rows, and a removal that did not name them would move who the
   * plan says is doing the work without saying so.
   */
  assumedAssignees: AssumedAssigneeFlip[];
}

export type RemoveRoleOutcome =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'forbidden' }
  | { ok: false; reason: 'in_use'; inUse: RoleInUse };

/** The trimmed name, or null when there is nothing there to name. */
function cleanName(name: string): string | null {
  const trimmed = name.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * One usage reading as the refusal reports it: the role's own rows counted, and
 * the readings that would move under them.
 *
 * One function for both readings the removal takes — the fast path's and the
 * transaction's — so the numbers a person is shown are built the same way
 * whichever of the two refused.
 */
function inUseFrom(usage: RoleUsageRows, roleId: string): RoleInUse {
  return {
    estimates: usage.estimates,
    actuals: usage.actuals,
    progress: usage.progress,
    measures: usage.measures,
    assignments: usage.assignments.filter((each) => each.roleId === roleId).length,
    assumedAssignees: assumedAssigneeFlips(usage.assignments, roleId),
  };
}

/**
 * A project's roles: adding, renaming and removing them.
 *
 * **Not journalled**, like the project's start date — there is no undo for a
 * role change. What protects the entries already in somebody's stack is the
 * revision bumps the removal makes: an undo whose estimate was deleted with the
 * role refuses as stale rather than writing a row against a role that is gone.
 *
 * Every write announces itself **after** the transaction has committed, so a
 * client that reads on the event reads a project the change is already in. See
 * {@link ProjectEvent}.
 *
 * Proof: with the publish moved ahead of the write in `add` and `remove`,
 * `records the event after the write, never before it` fails — the roles read
 * from inside the publish were still `Dev, QA`; watched 2026-08-08.
 */
export class RoleService {
  private readonly newId: () => string;

  constructor(private readonly opts: RoleServiceOptions) {
    this.newId = opts.newId ?? (() => crypto.randomUUID());
  }

  async add(projectId: string, actorId: string, name: string): Promise<RoleOutcome> {
    const clean = cleanName(name);
    // Before the project is read: a role called nothing would sit in every
    // header and every estimate row with no way to tell it from the next one.
    if (clean === null) return { ok: false, reason: 'name_required' };
    const project = await this.opts.projects.findById(projectId);
    if (project === null) return { ok: false, reason: 'not_found' };
    if (!canEdit(project, actorId)) return { ok: false, reason: 'forbidden' };

    const written = await this.opts.roles.add({ id: this.newId(), projectId, name: clean });
    if (!written.ok) return { ok: false, reason: written.reason };
    await this.opts.broadcast.publish(projectId, { type: 'role_added', role: written.role });
    return { ok: true, result: written.role };
  }

  async rename(
    projectId: string,
    roleId: string,
    actorId: string,
    name: string,
  ): Promise<RoleOutcome> {
    const clean = cleanName(name);
    if (clean === null) return { ok: false, reason: 'name_required' };
    const gate = await this.gate(projectId, roleId, actorId);
    if (!gate.ok) return gate;

    const written = await this.opts.roles.rename(roleId, clean);
    if (!written.ok) return { ok: false, reason: written.reason };
    await this.opts.broadcast.publish(projectId, { type: 'role_renamed', role: written.role });
    return { ok: true, result: written.role };
  }

  /**
   * Removes a role, refusing the first time when anything points at it.
   *
   * The refusal carries what would be lost rather than a bare conflict: the
   * estimates and assignments are rows somebody typed, and the assumed
   * assignees are readings that would change under them. A role nothing points
   * at is removed without a second call — there is nothing to warn about, and
   * asking anyway teaches people to confirm without reading.
   *
   * `cascade` is the caller saying it has seen those counts, and it is the only
   * thing carried across the two requests. **The count that decides is the one
   * inside the delete's transaction** — the read below is a fast path that
   * answers most refusals without opening one, and an estimate written after it
   * is refused by the transaction rather than deleted by it.
   *
   * A removal that removed nothing announces nothing. Two people pressing the
   * key at once both pass the gate, one transaction finds the role gone, and a
   * second `role_removed` would send every client to reread a change that did
   * not happen.
   *
   * Proof, all watched: with the refusal made unreachable, `refuses a role that
   * is used, counting what would go` fails — the first, unconfirmed call took
   * two estimates and an assignment with it (2026-08-08). With the transaction's
   * own count removed, `refuses an unconfirmed removal when an estimate lands
   * after the count` deletes that estimate and answers `ok`; with the
   * `not_found` branch below made to publish anyway, `refuses the loser of two
   * removals, bumping and announcing nothing` sees a phantom event (2026-08-09).
   */
  async remove(
    projectId: string,
    roleId: string,
    actorId: string,
    cascade: boolean,
  ): Promise<RemoveRoleOutcome> {
    const gate = await this.gate(projectId, roleId, actorId);
    if (!gate.ok)
      return { ok: false, reason: gate.reason === 'forbidden' ? 'forbidden' : 'not_found' };

    if (!cascade) {
      const seen = inUseFrom(await this.opts.roles.usageOf(projectId, roleId), roleId);
      if (seen.estimates > 0 || seen.assignments > 0) {
        return { ok: false, reason: 'in_use', inUse: seen };
      }
    }
    const removed = await this.opts.roles.remove(projectId, roleId, cascade);
    if (!removed.ok) {
      if (removed.reason === 'not_found') return { ok: false, reason: 'not_found' };
      // The transaction's own count, not the fast path's: it is the only one
      // that was still true at the moment the deletes would have run.
      return { ok: false, reason: 'in_use', inUse: inUseFrom(removed.usage, roleId) };
    }
    await this.opts.broadcast.publish(projectId, { type: 'role_removed', roleId });
    return { ok: true };
  }

  /**
   * The project this role belongs to, and whether the caller may write to it.
   *
   * A role of another project is `not_found` rather than `forbidden`: it is not
   * this project's role, and saying "you may not" would tell the caller it is.
   *
   * Proof: with the `projectId` comparison dropped, `refuses a role that belongs
   * to another project` fails — one project's route renamed another project's
   * role; watched 2026-08-08.
   */
  private async gate(
    projectId: string,
    roleId: string,
    actorId: string,
  ): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'forbidden' }> {
    const project = await this.opts.projects.findById(projectId);
    if (project === null) return { ok: false, reason: 'not_found' };
    if (!canEdit(project, actorId)) return { ok: false, reason: 'forbidden' };
    const role = await this.opts.roles.findById(roleId);
    if (role?.projectId !== projectId) return { ok: false, reason: 'not_found' };
    return { ok: true };
  }
}
