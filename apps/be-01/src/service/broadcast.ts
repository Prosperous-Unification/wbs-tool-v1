import { AsyncLocalStorage } from 'node:async_hooks';

import type { Step } from '../repository';
import type { NumberedWorkItem } from './work-item.service';

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
  | { type: 'saved_plans_changed' };

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
 * A {@link Broadcaster} that can hold a batch's announcements back.
 *
 * `PlanCommandRunner` states the rule its own broadcast follows: the lock covers
 * the transaction and nothing after it, because a push to gw-01 is a network
 * call and a lock held across it lets one slow gateway stall every write in the
 * process. `PushClient` retries six times with a 500ms→30s backoff, so the worst
 * case is about a minute **per push**.
 *
 * Three services broke that rule by publishing from inside `applyAll`:
 * `CapacityService.set`, `PriorityBandService.set` and
 * `DirectoryService.announce`, the last of them once per touched project, in
 * sequence. A tag rename across forty projects made forty event-log inserts and
 * forty gateway pushes with the process-wide write lock held.
 *
 * It was also unsound, not merely slow. Under ADR 0007 the batch runs in one
 * outer transaction, so those event-log inserts were savepoints inside it: a
 * command refused at step nine rolled back the recorded events for pushes that
 * had already left the process. `directory.service.ts`'s own doc argued the
 * opposite — "`recordEvent` opens a transaction of its own, so it cannot be
 * nested inside the write's" — which is true of a single directory route and
 * false of every directory command in a batch.
 *
 * So a held batch keeps its announcements until the runner has committed *and*
 * released the lock, and drops them entirely when it rolls back. Held events are
 * deduplicated when they carry nothing but a `type`, which is what makes forty
 * `directory_changed` for one rename into one per project.
 *
 * **A hold belongs to its caller, not to this object** (TASK-256). The queue
 * lives in an {@link AsyncLocalStorage}, so a publish is captured when it is
 * made *inside* the hold's own async context and not merely while the hold is
 * open. `held` used to be instance state and `services.ts` builds exactly one
 * instance, so during any open hold *every* publish through this object joined
 * that batch's queue — including one from an HTTP route that had committed its
 * own transaction and had nothing to do with the batch. A refused batch drops
 * its queue (`plan-commands.ts` answers a refusal with `pending: []`) and that
 * route's event went with it: the write happened and nobody was told. It
 * shipped that way for saved plans (TASK-255) and for all three `step_*` events
 * (TASK-256), and both were found by review rather than by a test.
 *
 * The context test is the right one because it asks the question the drop is
 * about. An incoming HTTP request is rooted in its own async context and never
 * inside `PlanCommandRunner`'s `hold` callback, so it reads no store and
 * publishes straight through; a command inside the batch reads the batch's
 * store and is queued, which is what the hold is for. That fixes every present
 * and future non-batch publisher at once rather than one wiring at a time —
 * including `WorkItemService.announceTreeNow` and {@link send} themselves,
 * which run after `hold` has returned and could be captured by a *following*
 * batch under instance state.
 *
 * Deferring by *caller* rather than by *clock* is also why the wiring in
 * `services.ts` no longer decides anything. Every publisher may hold the
 * wrapper; a publisher that is never part of a batch is simply never captured.
 */
export class DeferringBroadcaster implements Broadcaster {
  private readonly scope = new AsyncLocalStorage<HeldAnnouncement[]>();

  constructor(private readonly inner: Broadcaster) {}

  /**
   * Run `step` with every announcement *it* makes held, and hand back what it
   * queued.
   *
   * The caller decides whether they leave: {@link send} them after a commit,
   * drop them after a rollback.
   *
   * Two concurrent batches are no longer an error, and could not be expressed
   * before: each gets its own queue, because each runs in its own async
   * context. `PlanCommandRunner` serialises them behind the write lock anyway,
   * so this is a property rather than a feature.
   *
   * @throws when a hold is already open **in this context**. A nested hold
   * would shadow its parent's store, so the parent would commit having been
   * told nothing about the writes the child announced.
   */
  async hold<T>(step: () => Promise<T>): Promise<{ result: T; pending: HeldAnnouncement[] }> {
    // Proof: deleting these two lines makes `broadcast.test.ts`'s
    // `DeferringBroadcaster refuses a nested hold` fail on
    // `expect(nested).toBeInstanceOf(Error)` — the inner hold succeeds and
    // returns, shadowing the outer store. Watched 2026-09-04, 6 pass / 1 fail.
    // The check needed its own test once TASK-256 changed what it inspects:
    // reading instance state it caught two *concurrent* batches, which is the
    // failure `plan-commands.ts` names, and per-caller queues retired that
    // symptom entirely.
    if (this.scope.getStore() !== undefined)
      throw new Error('a batch is already holding announcements');
    const held: HeldAnnouncement[] = [];
    // `run` unwinds the store itself, on the throw path too — which is why
    // there is no `finally` here and why an exception cannot leak a queue.
    return this.scope.run(held, async () => ({ result: await step(), pending: held }));
  }

  /**
   * Publish what a hold queued, in the order it was queued.
   *
   * Straight to {@link inner} and never back through {@link publish}: this runs
   * after its own hold has returned, so a following batch that happened to be
   * open would otherwise capture the previous batch's committed events under
   * the old instance-state rule. It cannot now — this call is rooted in the
   * first request's context — and going to `inner` says so at the call site
   * rather than relying on that.
   */
  async send(pending: readonly HeldAnnouncement[]): Promise<void> {
    for (const each of pending) await this.inner.publish(each.projectId, each.event);
  }

  async publish(projectId: string, event: ProjectEvent): Promise<void> {
    const held = this.scope.getStore();
    if (held === undefined) {
      await this.inner.publish(projectId, event);
      return;
    }
    // Only an event that carries nothing but its type can be deduplicated: two
    // `directory_changed` for one project say the same thing, and two
    // `step_renamed` do not.
    const saysOnlyItsType = Object.keys(event).length === 1;
    if (
      saysOnlyItsType &&
      held.some((each) => each.projectId === projectId && each.event.type === event.type)
    ) {
      return;
    }
    held.push({ projectId, event });
  }

  latestSeq(projectId: string): Promise<number> {
    return this.inner.latestSeq(projectId);
  }
}
