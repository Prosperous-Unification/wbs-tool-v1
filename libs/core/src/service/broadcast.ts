import type { ScheduleEngine, SolverObjectiveName } from '@wbs/domain';
import type { SolverFailureReason } from '@wbs/domain';

import type { Step } from '../ports/step-store';
import type { NumberedWorkItem } from './numbered-work-item';

/**
 * What subscribers to `project:<id>` receive.
 *
 * One shape for the work items, and it is the whole tree. There were two: a
 * cell edit was to send the touched row and its ancestors, a structural change
 * the tree. The command bus retired the small one. Every write now arrives
 * through `PlanCommandRunner`, which collects a batch and announces **once**
 * after the transaction commits — and a batch is any set of rows at all, so
 * there is no per-row change left to describe. The narrow shape survived
 * unreachable for two releases before it was deleted; a whole plan is hundreds
 * of rows and one read after a write is the cheaper mistake.
 *
 * The three step events carry the step and **not** the tree, even though
 * removing one deletes estimates from it. A client reads the project's steps and
 * its tree together — one refresh, both reads — so a step event says which fact
 * moved and the client rereads both. Putting the tree in here would send a
 * second copy of it that the reader would have to reconcile with the steps it
 * has not read yet.
 */
export type ProjectEvent =
  | { type: 'tree_replaced'; workItems: NumberedWorkItem[] }
  | { type: 'plan_unavailable'; error: 'engine_unavailable'; engine: 'optimized' }
  | { type: 'step_added'; step: Step }
  | { type: 'step_renamed'; step: Step }
  | { type: 'step_removed'; stepId: string }
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
   * three step events make for carrying the step and not the tree.
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
  | { type: 'priority_bands_changed' }
  /**
   * One or more of the project's three optimizer settings has changed (tasks.md
   * 3b.3): whether the optimizer runs at all, which engine publishes the
   * schedule, and which objective's answer is the published one.
   *
   * It **carries the new values**, unlike `capacity_changed` and
   * `priority_bands_changed` which carry nothing. Those two say "read again"
   * about a list the client fetches beside the tree on every refresh; these
   * three are a project's own settings and are what a settings panel is
   * currently displaying, so a second screen with the panel open can repaint
   * the toggle from the event rather than round-trip for three booleans-worth
   * of state. All three are sent whatever moved, because a reader holding one
   * changed field and two stale ones cannot tell which it has.
   *
   * `schedule_optimized` is **not** this event: it is reserved for a stored
   * solver *result* arriving, which is a
   * different fact with a different payload and a different trigger. Emitting
   * a settings change as a result would tell a client a schedule had been
   * recomputed when nothing had run.
   */
  | {
      type: 'project_settings_changed';
      optimizationEnabled: boolean;
      scheduleEngine: ScheduleEngine;
      scheduleObjective: SolverObjectiveName;
    }
  | {
      type: 'schedule_optimized';
      projectId: string;
      generation: number;
      inputHash: string;
      objective: SolverObjectiveName;
      contractVersion: string;
      budgetMs: number;
    }
  | {
      type: 'schedule_optimization_failed';
      projectId: string;
      generation: number;
      inputHash: string;
      objective: SolverObjectiveName;
      contractVersion: string;
      budgetMs: number;
      failureReason: SolverFailureReason;
    }
  /**
   * A deterministic certificate has become the terminal answer for one exact
   * optimizer variant. The certificate stays in the keyed cache DTO; this
   * announcement carries the full release identity so every collaborator can
   * re-read that variant instead of remaining `pending` until another edit.
   */
  | {
      type: 'schedule_optimization_infeasible';
      projectId: string;
      generation: number;
      inputHash: string;
      objective: SolverObjectiveName;
      contractVersion: string;
      budgetMs: number;
    }
  /**
   * This project's list of saved plans has changed — one saved, renamed or
   * deleted.
   *
   * **The plan itself never changes, and that is what this event is for.** A
   * saved plan is immutable by construction, so unlike every other member of
   * this union nothing a second reader already holds has gone stale. What has
   * changed is the *set*: the shelf shows a plan that is not there, or is
   * missing one that is, or is captioned with a name somebody else replaced.
   *
   * It carries nothing, for `directory_changed`'s reason: a client reads the
   * project's saved plans as one list and the only useful thing to say is "read
   * again". Carrying the new record would additionally leak it to every reader
   * of the project including one who may not rename or delete it, which is a
   * permission the list route already decides for itself.
   *
   * Its own type rather than folding into `tree_replaced`, and the distinction
   * is load-bearing rather than cosmetic: **no date moved and no live row
   * changed**. A reader that treated a save as a tree change would re-fetch and
   * re-render a plan that is byte-identical to the one on screen, on every save
   * any collaborator makes.
   *
   * There is a second reader of this event beyond the shelf. TASK-232's 8.4
   * offers "this plan has changed since the comparison below was made" rather
   * than swapping the comparison out; before this event existed that affordance
   * could only be reached by the reader's *own* save, because nothing a
   * collaborator did ever arrived.
   */
  | { type: 'saved_plans_changed' }
  /**
   * A project's calendar markers changed — one was added, renamed, recoloured
   * or deleted.
   *
   * Its own type rather than `tree_replaced` or `directory_changed`, and the
   * distinction is the same load-bearing one `saved_plans_changed` draws: **no
   * work item moved and no date changed.** A marker is an annotation on the
   * axis, so a reader that folded this into a tree change would re-fetch and
   * re-render a plan byte-identical to the one on screen every time any
   * collaborator dropped a marker on a day.
   *
   * Content-free, for `directory_changed`'s reason: a client reads a project's
   * markers as one list, so the only useful thing to say is "read again".
   * Carrying the row would additionally announce it to every reader of the
   * project — including one the list route would have answered differently.
   */
  | { type: 'calendar_markers_changed' };

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

/** One announcement waiting for its batch to commit and let go of the lock. */
export interface HeldAnnouncement {
  projectId: string;
  event: ProjectEvent;
}

/**
 * One batch's announcements, held until it has committed and let go of its turn.
 *
 * **Per batch and handed over explicitly** (D24). What stood here before was a
 * wrapper with an `AsyncLocalStorage` queue: a publish joined the batch whose
 * async context it was made in. That is a correct answer to "whose event is
 * this" and an ambient one, and it needs a runtime that has `AsyncLocalStorage`
 * — which a browser does not. The batch's services are built over this object
 * instead, so the question is answered by the graph a caller was given rather
 * than by where its call stack came from, and the same code runs either side.
 *
 * The rule this exists for is `PlanCommandRunner`'s: the turn covers the unit of
 * work and nothing after it, because a push to gw-01 is a network call and a
 * turn held across it lets one slow gateway stall every write in the process.
 * Three services broke that rule by publishing from inside `applyAll`, and
 * under ADR 0007 those event-log inserts were savepoints inside the batch's
 * transaction: a command refused at step nine rolled back the recorded events
 * for pushes that had already left.
 *
 * Held events are deduplicated when they carry nothing but a `type`, which is
 * what makes forty `directory_changed` for one tag rename into one per project.
 */
export class AnnouncementCollector implements Broadcaster {
  private readonly held: HeldAnnouncement[] = [];

  constructor(private readonly inner: Broadcaster) {}

  publish(projectId: string, event: ProjectEvent): Promise<void> {
    // Only an event that carries nothing but its type can be deduplicated: two
    // `directory_changed` for one project say the same thing, and two
    // `step_renamed` do not.
    const saysOnlyItsType = Object.keys(event).length === 1;
    if (
      saysOnlyItsType &&
      this.held.some((each) => each.projectId === projectId && each.event.type === event.type)
    ) {
      return Promise.resolve();
    }
    this.held.push({ projectId, event });
    return Promise.resolve();
  }

  latestSeq(projectId: string): Promise<number> {
    return this.inner.latestSeq(projectId);
  }

  /** What this batch has announced so far, in the order it announced it. */
  get pending(): readonly HeldAnnouncement[] {
    return this.held;
  }

  /**
   * Publishes what the batch collected, in order.
   *
   * Called after the commit and after the turn is released — never inside
   * `UnitOfWork.run`, which is the half of the rule this class exists for.
   */
  async send(): Promise<void> {
    for (const each of this.held) await this.inner.publish(each.projectId, each.event);
  }
}
