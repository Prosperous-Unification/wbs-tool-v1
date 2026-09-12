import type { PlanEvent, PlanEventFilter, PlanEventStore } from '../ports/plan-event-store';
import type { ProjectStore } from '../ports/project-store';

export interface HistoryServiceOptions {
  projects: ProjectStore;
  events: PlanEventStore;
}

export type HistoryOutcome = { ok: true; value: PlanEvent[] } | { ok: false; reason: 'not_found' };

/**
 * The plan's history, read.
 *
 * **Reading is open to every authenticated account, like every other read in this
 * product.** `projectController`'s own split: authentication on every route,
 * authorisation only where something is written. There is nothing to write here —
 * the history is written by `WorkItemService.record` as a side of the command it
 * records, and this service has no write method at all, which is what makes
 * "append-only" a property of the code rather than a promise in a comment.
 *
 * The project is read before the events so an absent project is `not_found`
 * rather than an empty history. The two are different answers and a client must
 * be able to tell them apart: a plan somebody just deleted and a plan nobody has
 * edited yet would otherwise look identical.
 *
 * **Not a view.** What comes back is the rows, `before` and `after` still the
 * commands they were written as. Turning "set_estimate from {3,5,8} to {3,5,13}"
 * into a sentence about a figure is R5's H5, and doing it here would fix the
 * shape of a reading surface nobody has designed — see
 * `notes/wbs-brief-2026-08-14-r5-r6-history.md` §6.
 */
export class HistoryService {
  constructor(private readonly opts: HistoryServiceOptions) {}

  async read(projectId: string, filter: PlanEventFilter): Promise<HistoryOutcome> {
    const project = await this.opts.projects.findById(projectId);
    if (project === null) return { ok: false, reason: 'not_found' };
    return { ok: true, value: await this.opts.events.listFor(projectId, filter) };
  }
}
