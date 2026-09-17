import { stepIsInUse } from '@wbs/domain';

import type { Clock } from '../ports/clock';
import type { ProjectStore } from '../ports/project-store';
import type { Step, StepStore, StepUsageRows } from '../ports/step-store';
import { type AssumedAssigneeFlip, assumedAssigneeFlips } from './assumed-assignee';
import type { Broadcaster } from './broadcast';
import { cleanName } from './clean-name';
import { canEdit } from './project.service';

export interface StepServiceOptions {
  projects: ProjectStore;
  steps: StepStore;
  /**
   * Required, like the work item service's. A step service built without one
   * would change what every estimate in a project means and tell nobody — every
   * other client would keep drawing a column for a step that has gone until
   * somebody reloaded.
   */
  broadcast: Broadcaster;
  /** The instant every write is dated from and the ids it mints — see {@link Clock}. */
  clock: Clock;
}

/** Why a step could not be added or renamed. All four are states, not faults. */
export type StepRefusal = 'not_found' | 'forbidden' | 'name_required' | 'taken';

export type StepOutcome = { ok: true; value: Step } | { ok: false; reason: StepRefusal };

/** What a removal would take with it, as the refusal reports it. */
export interface StepInUse {
  estimates: number;
  /**
   * Days already recorded against this step — a count of rows, not a sum of
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
   * Work items that have said where this step's work has got to — a count of
   * rows, for {@link StepInUse.actuals}' reason and in its tense.
   *
   * Reported separately again because it is a third kind of loss: an estimate is
   * a guess that can be made again, an actual is a record of a week, and a state
   * is somebody's statement that the work is finished. A removal that took one
   * silently would turn done work back into work nobody has started.
   */
  progress: number;
  /**
   * Figures this step holds in the units that are not days — a count of
   * **rows**, so a pair holding a token estimate and an hours fact counts two.
   *
   * A fourth kind of loss, reported separately for the three above's reason: an
   * estimate is a guess that can be made again, a recorded day and a recorded
   * hour are accounts of time that was spent, and a token figure is what a
   * plan's agent work cost. Rows rather than pairs because each metric is a
   * separate statement — see `StepUsageRows.measures` in `repository/index.ts`.
   *
   * Travels before any face reads it, for {@link StepInUse.actuals}' reason:
   * `fe-01`'s `StepUsage` names estimates and assignments only, and has been
   * silent about `actuals` and `progress` since they landed. Widening that
   * sentence is a face change and belongs to a chunk that gates `fe-01`.
   */
  measures: number;
  /** Explicit assignments on this step. The assumed ones are in `assumedAssignees`. */
  assignments: number;
  /**
   * Every work item whose assumed assignee the removal would change — nobody
   * wrote those rows, and a removal that did not name them would move who the
   * plan says is doing the work without saying so.
   */
  assumedAssignees: AssumedAssigneeFlip[];
}

export type RemoveStepOutcome =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'forbidden' }
  | { ok: false; reason: 'in_use'; inUse: StepInUse };

/**
 * One usage reading as the refusal reports it: the step's own rows counted, and
 * the readings that would move under them.
 *
 * One function for both readings the removal takes — the fast path's and the
 * transaction's — so the numbers a person is shown are built the same way
 * whichever of the two refused.
 */
function inUseFrom(usage: StepUsageRows, stepId: string): StepInUse {
  return {
    estimates: usage.estimates,
    actuals: usage.actuals,
    progress: usage.progress,
    measures: usage.measures,
    assignments: usage.assignments.filter((each) => each.stepId === stepId).length,
    assumedAssignees: assumedAssigneeFlips(usage.assignments, stepId),
  };
}

/**
 * A project's steps: adding, renaming and removing them.
 *
 * **Not journalled**, like the project's start date — there is no undo for a
 * step change. What protects the entries already in somebody's stack is the
 * revision bumps the removal makes: an undo whose estimate was deleted with the
 * step refuses as stale rather than writing a row against a step that is gone.
 *
 * Every write announces itself **after** the transaction has committed, so a
 * client that reads on the event reads a project the change is already in. See
 * {@link ProjectEvent}.
 *
 * Proof: with the publish moved ahead of the write in `add` and `remove`,
 * `records the event after the write, never before it` fails — the steps read
 * from inside the publish were still `Dev, QA`; watched 2026-08-08.
 */
export class StepService {
  private readonly clock: Clock;

  constructor(private readonly opts: StepServiceOptions) {
    this.clock = opts.clock;
  }

  async add(projectId: string, actorId: string, name: string): Promise<StepOutcome> {
    const clean = cleanName(name);
    // Before the project is read: a step called nothing would sit in every
    // header and every estimate row with no way to tell it from the next one.
    if (clean === null) return { ok: false, reason: 'name_required' };
    const project = await this.opts.projects.findById(projectId);
    if (project === null) return { ok: false, reason: 'not_found' };
    if (!canEdit(project, actorId)) return { ok: false, reason: 'forbidden' };

    const written = await this.opts.steps.add(
      { id: this.clock.newId(), projectId, name: clean },
      this.clock.stampFor(actorId),
    );
    if (!written.ok) return { ok: false, reason: written.reason };
    await this.opts.broadcast.publish(projectId, { type: 'step_added', step: written.step });
    return { ok: true, value: written.step };
  }

  async rename(
    projectId: string,
    stepId: string,
    actorId: string,
    name: string,
  ): Promise<StepOutcome> {
    const clean = cleanName(name);
    if (clean === null) return { ok: false, reason: 'name_required' };
    const gate = await this.gate(projectId, stepId, actorId);
    if (!gate.ok) return gate;

    const written = await this.opts.steps.rename(stepId, clean, this.clock.stampFor(actorId));
    if (!written.ok) return { ok: false, reason: written.reason };
    await this.opts.broadcast.publish(projectId, { type: 'step_renamed', step: written.step });
    return { ok: true, value: written.step };
  }

  /**
   * Removes a step, refusing the first time when anything points at it.
   *
   * The refusal carries what would be lost rather than a bare conflict: the
   * estimates and assignments are rows somebody typed, and the assumed
   * assignees are readings that would change under them. A step nothing points
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
   * key at once both pass the gate, one transaction finds the step gone, and a
   * second `step_removed` would send every client to reread a change that did
   * not happen.
   *
   * Proof, all watched: with the refusal made unreachable, `refuses a step that
   * is used, counting what would go` fails — the first, unconfirmed call took
   * two estimates and an assignment with it (2026-08-08). With the transaction's
   * own count removed, `refuses an unconfirmed removal when an estimate lands
   * after the count` deletes that estimate and answers `ok`; with the
   * `not_found` branch below made to publish anyway, `refuses the loser of two
   * removals, bumping and announcing nothing` sees a phantom event (2026-08-09).
   */
  async remove(
    projectId: string,
    stepId: string,
    actorId: string,
    cascade: boolean,
  ): Promise<RemoveStepOutcome> {
    const gate = await this.gate(projectId, stepId, actorId);
    if (!gate.ok)
      return { ok: false, reason: gate.reason === 'forbidden' ? 'forbidden' : 'not_found' };

    if (!cascade) {
      const seen = inUseFrom(await this.opts.steps.usageOf(projectId, stepId), stepId);
      if (stepIsInUse(seen)) {
        return { ok: false, reason: 'in_use', inUse: seen };
      }
    }
    const removed = await this.opts.steps.remove(
      projectId,
      stepId,
      cascade,
      this.clock.stampFor(actorId),
    );
    if (!removed.ok) {
      if (removed.reason === 'not_found') return { ok: false, reason: 'not_found' };
      // The transaction's own count, not the fast path's: it is the only one
      // that was still true at the moment the deletes would have run.
      return { ok: false, reason: 'in_use', inUse: inUseFrom(removed.usage, stepId) };
    }
    await this.opts.broadcast.publish(projectId, { type: 'step_removed', stepId });
    return { ok: true };
  }

  /**
   * The project this step belongs to, and whether the caller may write to it.
   *
   * A step of another project is `not_found` rather than `forbidden`: it is not
   * this project's step, and saying "you may not" would tell the caller it is.
   *
   * Proof: with the `projectId` comparison dropped, `refuses a step that belongs
   * to another project` fails — one project's route renamed another project's
   * step; watched 2026-08-08.
   */
  private async gate(
    projectId: string,
    stepId: string,
    actorId: string,
  ): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'forbidden' }> {
    const project = await this.opts.projects.findById(projectId);
    if (project === null) return { ok: false, reason: 'not_found' };
    if (!canEdit(project, actorId)) return { ok: false, reason: 'forbidden' };
    const step = await this.opts.steps.findById(stepId);
    if (step?.projectId !== projectId) return { ok: false, reason: 'not_found' };
    return { ok: true };
  }
}
