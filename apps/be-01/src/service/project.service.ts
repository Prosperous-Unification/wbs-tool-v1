import { isIsoDate } from '@wbs/domain';

import type { Project, ProjectPatch, ProjectStore, ProjectWithAccess, Role } from '../repository';
import { ROLE_POSITION_STEP } from '../repository';

/**
 * The roles a project starts with, **in role order**. Two sets of estimates is
 * the default the product asks for; a project that began with none would accept
 * no estimates at all until someone thought to add a role.
 */
export const STARTING_ROLES = ['Dev', 'QA'] as const;

export interface ProjectWithRoles {
  project: Project;
  roles: Role[];
}

export type UpdateOutcome =
  | { ok: true; result: Project }
  | { ok: false; reason: 'not_found' | 'forbidden' | 'bad_start_date' };

export interface ProjectServiceOptions {
  projects: ProjectStore;
  now?: () => number;
  newId?: () => string;
}

/**
 * Whether `actorId` may write to `project`.
 *
 * Exported because every later mutation asks the same question — work items,
 * estimates, freeze — and a second copy of this rule is how one of them ends up
 * enforcing a different one. Reading is deliberately not gated: an unrestricted
 * project is editable by any authenticated account, and a restricted one is
 * readable by all and writable only by its owner.
 */
export function canEdit(project: Project, actorId: string): boolean {
  return !project.restricted || project.ownerId === actorId;
}

export class ProjectService {
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly opts: ProjectServiceOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.newId = opts.newId ?? (() => crypto.randomUUID());
  }

  async create(name: string, ownerId: string): Promise<ProjectWithRoles> {
    const project: Project = {
      id: this.newId(),
      name,
      ownerId,
      restricted: false,
      // PERT is the default: it is the reason three points are collected, and
      // a project that had to choose before it had any estimates would be
      // choosing about risk it has not met yet.
      estimateMethod: 'pert',
      // Not the day it was made: a plan with no start date is an ordinary
      // state, and inventing one would put dates on screen nobody chose.
      startDate: null,
      solutionRef: null,
      // Never written to since it came into being. Its starting roles arrive
      // in the same transaction, so they are part of that beginning rather
      // than a first change to it.
      revision: 0,
      createdAt: this.now(),
    };
    // Positions written here rather than left to the store: `create` takes the
    // seed as it is, and `STARTING_ROLES` is already an order — Dev is done
    // before QA, which is the order the schedule runs a work item's slices in.
    const roles = STARTING_ROLES.map((roleName, place) => ({
      id: this.newId(),
      projectId: project.id,
      name: roleName,
      position: (place + 1) * ROLE_POSITION_STEP,
    }));
    await this.opts.projects.create(project, roles);
    return { project, roles };
  }

  /**
   * The caller's list, in the caller's order.
   *
   * Takes the account id rather than answering one order for everybody: what
   * "most recently opened" means is a fact about who is asking, and computing
   * it anywhere but the query would mean reading every access row to sort a
   * list the database can already sort.
   */
  list(actorId: string): Promise<ProjectWithAccess[]> {
    return this.opts.projects.listFor(actorId);
  }

  /**
   * Records that `actorId` is now working in `id`.
   *
   * Deliberately **not** gated by {@link canEdit}: every authenticated account
   * may read every project, so gating this would leave a reader's own picker
   * permanently sorted by creation date — the exact thing this change exists to
   * fix. It is the caller's own navigation history and changes nothing anyone
   * else can see.
   */
  async open(id: string, actorId: string): Promise<boolean> {
    const project = await this.opts.projects.findById(id);
    // A project that is not there is not opened. Recording it anyway would
    // leave a row pointing at nothing, and the foreign key would refuse it in
    // production while the fixture happily accepted it.
    if (project === null) return false;
    await this.opts.projects.recordOpen(actorId, id, this.now());
    return true;
  }

  async read(id: string): Promise<ProjectWithRoles | null> {
    const project = await this.opts.projects.findById(id);
    if (project === null) return null;
    return { project, roles: await this.opts.projects.rolesOf(id) };
  }

  async readBySolutionSlug(slug: string): Promise<ProjectWithRoles | null> {
    const project = await this.opts.projects.findBySolutionSlug(slug);
    if (project === null) return null;
    return { project, roles: await this.opts.projects.rolesOf(project.id) };
  }

  async update(id: string, actorId: string, patch: ProjectPatch): Promise<UpdateOutcome> {
    // `2026-02-31` matches the route's pattern and is not a day. Refused here
    // rather than stored: the column is text, and a date the scheduler cannot
    // parse would throw on every later read of this project.
    if (patch.startDate != null && !isIsoDate(patch.startDate)) {
      return { ok: false, reason: 'bad_start_date' };
    }
    const project = await this.opts.projects.findById(id);
    if (project === null) return { ok: false, reason: 'not_found' };
    if (!canEdit(project, actorId)) return { ok: false, reason: 'forbidden' };
    const updated = await this.opts.projects.update(id, patch);
    // Gone between the read and the write. Reporting success would tell the
    // caller their rename landed on a project that no longer exists.
    if (updated === null) return { ok: false, reason: 'not_found' };
    return { ok: true, result: updated };
  }
}
