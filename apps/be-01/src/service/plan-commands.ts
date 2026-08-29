import type { CommandJournalStore } from '../repository';
import type { CapacityService } from './capacity.service';
import type { DirectoryService } from './directory.service';
import type { OuterTransaction } from './outer-transaction';
import { MOST_COMMANDS_IN_A_BATCH, type PlanCommand, type PlanCommandKind } from './plan-command';
import type { PriorityBandService } from './priority-band.service';
import type { UndoOutcome, WorkItemService } from './work-item.service';
import type { WriteLock } from './write-lock';

/** What one step of an applied batch produced: the id of anything it created. */
export interface BatchResult {
  index: number;
  ref?: string;
  id?: string;
}

/** Why a batch was refused, and at which step. */
export interface BatchRefusal {
  ok: false;
  at: number;
  kind: PlanCommandKind;
  reason: string;
}

export type BatchOutcome =
  | { ok: true; results: BatchResult[]; undoable: boolean; redoable: boolean }
  | BatchRefusal;

export interface PlanCommandRunnerOptions {
  workItems: WorkItemService;
  directory: DirectoryService;
  capacity: CapacityService;
  priorityBands: PriorityBandService;
  journal: CommandJournalStore;
  transactions: OuterTransaction;
  lock: WriteLock;
}

/** Thrown inside a batch to stop it; caught by `run`, never seen outside. */
class Refused extends Error {
  constructor(
    readonly at: number,
    readonly kind: PlanCommandKind,
    readonly reason: string,
  ) {
    super(`${kind} at ${String(at)}: ${reason}`);
  }
}

/**
 * Applies a {@link Command batch}: every step through the service it belongs
 * to, inside one {@link OuterTransaction}, behind the {@link Write lock}, then
 * one journal entry and one broadcast — `plan-commands` D2–D4 and ADR 0007.
 *
 * Refs are the runner's: a create's id is remembered under its `ref`, and any
 * `…Ref` field is replaced by that id before the service sees the step. A ref
 * nobody minted, or minted twice, refuses the batch at that step.
 *
 * Undo and redo run through here too, for the same reason a batch does: a
 * batch's inverse is many steps, and only the outer transaction can make a
 * step that fails midway take the ones before it back.
 */
export class PlanCommandRunner {
  constructor(private readonly opts: PlanCommandRunnerOptions) {}

  run(projectId: string, actorId: string, commands: readonly PlanCommand[]): Promise<BatchOutcome> {
    return this.opts.lock.run(async () => {
      const over = commands.at(MOST_COMMANDS_IN_A_BATCH);
      if (over !== undefined) {
        return {
          ok: false,
          at: MOST_COMMANDS_IN_A_BATCH,
          kind: over.kind,
          reason: 'too_many_commands',
        };
      }
      const { workItems, transactions } = this.opts;
      transactions.begin();
      let collected;
      try {
        collected = await workItems.collect(() => this.applyAll(projectId, actorId, commands));
        await workItems.recordCollected(projectId, actorId, collected.recordings);
      } catch (cause) {
        transactions.rollback();
        if (cause instanceof Refused) {
          return { ok: false, at: cause.at, kind: cause.kind, reason: cause.reason };
        }
        throw cause;
      }
      transactions.commit();
      if (collected.dirty) await workItems.announceTreeNow(projectId);
      const state = await workItems.undoState(projectId, actorId);
      return { ok: true, results: collected.result, ...state };
    });
  }

  undo(projectId: string, actorId: string): Promise<UndoOutcome> {
    return this.walk(() => this.opts.workItems.undo(projectId, actorId));
  }

  redo(projectId: string, actorId: string): Promise<UndoOutcome> {
    return this.walk(() => this.opts.workItems.redo(projectId, actorId));
  }

  /**
   * One undo or redo inside the outer transaction. A refusal rolls everything
   * back — a batch inverse that failed at step three has taken steps one and
   * two back too — and then discards the stale entry again, outside the
   * transaction, because the service's own discard went with the rollback.
   */
  private walk(step: () => Promise<UndoOutcome>): Promise<UndoOutcome> {
    return this.opts.lock.run(async () => {
      const { transactions, journal } = this.opts;
      transactions.begin();
      let outcome: UndoOutcome;
      try {
        outcome = await step();
      } catch (cause) {
        transactions.rollback();
        throw cause;
      }
      if (outcome.ok) {
        transactions.commit();
        return outcome;
      }
      transactions.rollback();
      if (outcome.entryId !== undefined) await journal.discard(outcome.entryId);
      return outcome;
    });
  }

  private async applyAll(
    projectId: string,
    actorId: string,
    commands: readonly PlanCommand[],
  ): Promise<BatchResult[]> {
    const refs = new Map<string, string>();
    const results: BatchResult[] = [];
    for (const [index, command] of commands.entries()) {
      // Typed on the binding, not inferred from the arrow: TypeScript narrows
      // after a call only when the callee's `never` is declared on the name.
      const refuse: (reason: string) => never = (reason) => {
        throw new Refused(index, command.kind, reason);
      };
      const id = (given: string | null | undefined, ref: string | undefined): string | null => {
        if (ref !== undefined) {
          const minted = refs.get(ref);
          if (minted === undefined) refuse('unknown_ref');
          return minted;
        }
        return given ?? null;
      };
      const required = (given: string | undefined, ref: string | undefined): string => {
        const found = id(given, ref);
        if (found === null) refuse('missing_id');
        return found;
      };
      const ids = (given: readonly string[] | undefined, named: readonly string[] | undefined) => [
        ...(given ?? []),
        ...(named ?? []).map((ref) => required(undefined, ref)),
      ];
      const mint = (ref: string | undefined, created: string): BatchResult => {
        if (ref !== undefined) {
          if (refs.has(ref)) refuse('duplicate_ref');
          refs.set(ref, created);
        }
        return { index, ref, id: created };
      };
      const plain = (): BatchResult => ({ index });
      const { workItems, directory, capacity, priorityBands } = this.opts;
      const reasonOf = <T>(outcome: { ok: true; result: T } | { ok: false; reason: string }): T =>
        outcome.ok ? outcome.result : refuse(outcome.reason);
      const done = (outcome: { ok: true } | { ok: false; reason: string }): BatchResult => {
        if (!outcome.ok) refuse(outcome.reason);
        return plain();
      };

      switch (command.kind) {
        case 'createWorkItem': {
          if (command.ref !== undefined && refs.has(command.ref)) refuse('duplicate_ref');
          const created = reasonOf(
            await workItems.create(projectId, actorId, {
              parentId: id(command.parentId, command.parentRef),
              afterId: id(command.afterId, command.afterRef),
              ...(command.name === undefined ? {} : { name: command.name }),
              ...(command.notes === undefined ? {} : { notes: command.notes }),
            }),
          );
          results.push(mint(command.ref, created.id));
          break;
        }
        case 'patchWorkItem': {
          const { serviceRefs, tagRefs, teamRefs, ...patch } = command.patch;
          const resolved = {
            ...patch,
            ...(serviceRefs === undefined
              ? {}
              : { serviceIds: ids(patch.serviceIds, serviceRefs) }),
            ...(tagRefs === undefined ? {} : { tagIds: ids(patch.tagIds, tagRefs) }),
            ...(teamRefs === undefined ? {} : { teamIds: ids(patch.teamIds, teamRefs) }),
          };
          reasonOf(
            await workItems.patch(
              required(command.workItemId, command.workItemRef),
              actorId,
              resolved,
            ),
          );
          results.push(plain());
          break;
        }
        case 'moveWorkItem':
          reasonOf(
            await workItems.move(required(command.workItemId, command.workItemRef), actorId, {
              parentId: id(command.parentId, command.parentRef),
              afterId: id(command.afterId, command.afterRef),
            }),
          );
          results.push(plain());
          break;
        case 'duplicateWorkItem': {
          if (command.ref !== undefined && refs.has(command.ref)) refuse('duplicate_ref');
          const copy = reasonOf(
            await workItems.duplicate(required(command.workItemId, command.workItemRef), actorId),
          );
          results.push(mint(command.ref, copy.id));
          break;
        }
        case 'deleteWorkItem':
          reasonOf(
            await workItems.remove(
              required(command.workItemId, command.workItemRef),
              actorId,
              command.strategy ?? null,
            ),
          );
          results.push(plain());
          break;
        case 'setEstimate':
          reasonOf(
            await workItems.setEstimate(
              required(command.workItemId, command.workItemRef),
              actorId,
              command.roleId,
              command.days,
            ),
          );
          results.push(plain());
          break;
        case 'clearEstimate':
          reasonOf(
            await workItems.clearEstimate(
              required(command.workItemId, command.workItemRef),
              actorId,
              command.roleId,
            ),
          );
          results.push(plain());
          break;
        case 'setActual':
          reasonOf(
            await workItems.setActual(
              required(command.workItemId, command.workItemRef),
              actorId,
              command.roleId,
              command.days,
            ),
          );
          results.push(plain());
          break;
        case 'clearActual':
          reasonOf(
            await workItems.clearActual(
              required(command.workItemId, command.workItemRef),
              actorId,
              command.roleId,
            ),
          );
          results.push(plain());
          break;
        case 'setProgress':
          reasonOf(
            await workItems.setProgress(
              required(command.workItemId, command.workItemRef),
              actorId,
              command.roleId,
              command.state,
            ),
          );
          results.push(plain());
          break;
        case 'clearProgress':
          reasonOf(
            await workItems.clearProgress(
              required(command.workItemId, command.workItemRef),
              actorId,
              command.roleId,
            ),
          );
          results.push(plain());
          break;
        case 'setMeasure':
          reasonOf(
            await workItems.setMeasure(
              required(command.workItemId, command.workItemRef),
              actorId,
              command.roleId,
              command.metric,
              command.value,
            ),
          );
          results.push(plain());
          break;
        case 'clearMeasure':
          reasonOf(
            await workItems.clearMeasure(
              required(command.workItemId, command.workItemRef),
              actorId,
              command.roleId,
              command.metric,
            ),
          );
          results.push(plain());
          break;
        case 'setAssignee':
          reasonOf(
            await workItems.assign(
              required(command.workItemId, command.workItemRef),
              actorId,
              command.roleId,
              id(command.personId, command.personRef),
            ),
          );
          results.push(plain());
          break;
        case 'addDependency':
          reasonOf(
            await workItems.addDependency(
              required(command.workItemId, command.workItemRef),
              actorId,
              required(command.predecessorId, command.predecessorRef),
            ),
          );
          results.push(plain());
          break;
        case 'removeDependency':
          reasonOf(
            await workItems.removeDependency(
              required(command.workItemId, command.workItemRef),
              actorId,
              required(command.predecessorId, command.predecessorRef),
            ),
          );
          results.push(plain());
          break;
        case 'freezeProject':
          reasonOf(await workItems.freeze(projectId, actorId));
          results.push(plain());
          break;
        case 'unfreezeProject':
          reasonOf(await workItems.unfreezeProject(projectId, actorId));
          results.push(plain());
          break;
        case 'unfreezeWorkItem':
          reasonOf(
            await workItems.unfreeze(required(command.workItemId, command.workItemRef), actorId),
          );
          results.push(plain());
          break;
        case 'setCapacity':
          reasonOf(
            await capacity.set(
              projectId,
              actorId,
              required(command.teamId, command.teamRef),
              command.size,
            ),
          );
          results.push(plain());
          break;
        case 'setPriorityBands':
          reasonOf(await priorityBands.set(projectId, actorId, command.bands));
          results.push(plain());
          break;
        case 'createTeam': {
          if (command.ref !== undefined && refs.has(command.ref)) refuse('duplicate_ref');
          const team = await directory.addTeam(command.name);
          if (team === null) refuse('invalid_name');
          results.push(mint(command.ref, team.id));
          break;
        }
        case 'patchTeam':
          reasonOf(
            await directory.patchTeam(required(command.teamId, command.teamRef), command.patch),
          );
          results.push(plain());
          break;
        case 'deleteTeam':
          results.push(
            done(
              await directory.removeTeam(
                required(command.teamId, command.teamRef),
                command.cascade ?? false,
              ),
            ),
          );
          break;
        case 'createPerson': {
          if (command.ref !== undefined && refs.has(command.ref)) refuse('duplicate_ref');
          const person = reasonOf(
            await directory.addPerson(command.name, ids(command.teamIds, command.teamRefs)),
          );
          results.push(mint(command.ref, person.id));
          break;
        }
        case 'patchPerson':
          reasonOf(
            await directory.patchPerson(
              required(command.personId, command.personRef),
              command.patch,
            ),
          );
          results.push(plain());
          break;
        case 'deletePerson':
          results.push(
            done(
              await directory.removePerson(
                required(command.personId, command.personRef),
                command.cascade ?? false,
              ),
            ),
          );
          break;
        case 'createTag': {
          if (command.ref !== undefined && refs.has(command.ref)) refuse('duplicate_ref');
          const tag = await directory.addTag(command.name);
          if (tag === null) refuse('invalid_name');
          results.push(mint(command.ref, tag.id));
          break;
        }
        case 'patchTag':
          reasonOf(
            await directory.renameTag(required(command.tagId, command.tagRef), command.name),
          );
          results.push(plain());
          break;
        case 'deleteTag':
          results.push(
            done(
              await directory.removeTag(
                required(command.tagId, command.tagRef),
                command.cascade ?? false,
              ),
            ),
          );
          break;
        case 'createService': {
          if (command.ref !== undefined && refs.has(command.ref)) refuse('duplicate_ref');
          const service = await directory.addService(command.name);
          if (service === null) refuse('invalid_name');
          results.push(mint(command.ref, service.id));
          break;
        }
        case 'patchService':
          reasonOf(
            await directory.renameService(
              required(command.serviceId, command.serviceRef),
              command.name,
            ),
          );
          results.push(plain());
          break;
        case 'deleteService':
          results.push(
            done(
              await directory.removeService(
                required(command.serviceId, command.serviceRef),
                command.cascade ?? false,
              ),
            ),
          );
          break;
      }
    }
    return results;
  }
}
