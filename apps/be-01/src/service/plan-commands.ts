import type {
  Person,
  PersonWithTeams,
  Service,
  ServiceTeam,
  Tag,
  TeamWithServices,
  WorkItemType,
} from '../repository';
import type { DeferringBroadcaster, HeldAnnouncement } from './broadcast';
import type { CapacityService } from './capacity.service';
import type {
  DirectoryOutcome,
  DirectoryRefusal,
  RemoveDirectoryOutcome,
} from './directory.service';
import type { DirectoryService } from './directory.service';
import type { DirectoryUsage } from './directory-usage';
import { MOST_COMMANDS_IN_A_BATCH, type PlanCommand, type PlanCommandKind } from './plan-command';
import type { PriorityBandService } from './priority-band.service';
import type { Decision, UnitOfWork } from './unit-of-work';
import type { WorkItemRefusal } from './work-item.service';
import type { Collected, UndoOutcome, WorkItemService } from './work-item.service';

/**
 * What one step of an applied batch produced: the id of anything it created,
 * and for a directory create or patch the entry as its list route shows it —
 * the browser's `addTeam`/`renameTag` answer with the row, and a second read
 * for what the batch just wrote would be the round trip this route removes.
 */
interface AppliedBase {
  index: number;
  ref?: string;
  id?: string;
}
interface CommandEntities {
  createTeam: ServiceTeam;
  // Proof: widening to ServiceTeam made the actual producer type fixture report TS2578.
  patchTeam: TeamWithServices;
  // Proof: widening to ServiceTeam made the missing-person-kind type fixture report TS2578.
  createPerson: Person;
  patchPerson: PersonWithTeams;
  createTag: Tag;
  patchTag: Tag;
  createService: Service;
  patchService: Service;
  createWorkItemType: WorkItemType;
  patchWorkItemType: WorkItemType;
}
type EntityKind = keyof CommandEntities;
type PlainKind = Exclude<PlanCommandKind, EntityKind>;
type MintedKind = 'createWorkItem' | 'duplicateWorkItem' | Extract<EntityKind, `create${string}`>;
// Proof: making minted id optional produced two TS2578 diagnostics in the created-result fixtures.
type MintedBase = AppliedBase & { id: string };
/** Internal kind identifies the producer's exact entity contract; controllers erase it from the unchanged wire. */
export type AppliedCommand =
  | (AppliedBase & { kind: Exclude<PlainKind, MintedKind>; entity?: never })
  | (MintedBase & { kind: Extract<PlainKind, MintedKind>; entity?: never })
  | {
      [K in EntityKind]: (K extends MintedKind ? MintedBase : AppliedBase) & {
        kind: K;
        entity: CommandEntities[K];
      };
    }[EntityKind];

type PlainReason =
  | Exclude<WorkItemRefusal, 'deadline_before_project_start'>
  | DirectoryRefusal
  | 'too_many_commands'
  | 'project_required'
  | 'unknown_ref'
  | 'missing_id'
  | 'duplicate_ref';
type Refusal =
  | { reason: PlainReason; detail?: never }
  | {
      reason: 'deadline_before_project_start';
      detail: { workItemId: string; projectDayZero: string };
    }
  | { reason: 'taken'; detail: { name: string } }
  | { reason: 'in_use'; detail: { usage: DirectoryUsage } };
/** A runtime refusal always carries its command index and recognized kind. */
export type BatchRefusal = { ok: false; at: number; kind: PlanCommandKind } & Refusal;
type ServiceRefusal =
  | { ok: false; reason: PlainReason }
  | {
      ok: false;
      reason: 'deadline_before_project_start';
      workItemId?: string;
      projectDayZero?: string;
    }
  | Extract<DirectoryOutcome<never> | RemoveDirectoryOutcome, { ok: false }>;

export type BatchOutcome =
  { ok: true; results: AppliedCommand[]; undoable: boolean; redoable: boolean } | BatchRefusal;

export interface PlanCommandRunnerOptions {
  workItems: WorkItemService;
  directory: DirectoryService;
  capacity: CapacityService;
  priorityBands: PriorityBandService;
  /**
   * What the batch is one of. It takes the source's one turn for the whole act
   * and settles every write together (ADR 0015); the services above write
   * through stores built over an already-open gate, because they are the
   * batch's own and a second turn would wait for this one (D20).
   */
  uow: UnitOfWork;
  /**
   * The broadcaster the directory, capacity and priority-band services publish
   * through, so this runner can hold their announcements until the batch has
   * committed and let go of the lock. See {@link DeferringBroadcaster}.
   */
  announcements: DeferringBroadcaster;
}

/** The kinds that need no project: the directory's. */
const DIRECTORY_KINDS: ReadonlySet<PlanCommandKind> = new Set([
  'createTeam',
  'patchTeam',
  'deleteTeam',
  'createPerson',
  'patchPerson',
  'deletePerson',
  'createTag',
  'createWorkItemType',
  'patchWorkItemType',
  'deleteWorkItemType',
  'patchTag',
  'deleteTag',
  'createService',
  'patchService',
  'deleteService',
]);

/** Thrown inside a batch to stop it; caught by `run`, never seen outside. */
class Refused extends Error {
  constructor(
    readonly at: number,
    readonly kind: PlanCommandKind,
    readonly refusal: Refusal,
  ) {
    super(`${kind} at ${String(at)}: ${refusal.reason}`);
  }
}

/**
 * Applies a {@link Command batch}: every step through the service it belongs
 * to, as one {@link Unit of work} — one {@link Turn} at the source's write
 * coordinator, and every write settled together — then
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
    return this.execute(projectId, actorId, commands);
  }

  /**
   * A batch with no project: directory commands only, for the directory page
   * and for a model editing the directory on its own. Same turn, same unit of
   * work, and nothing is journalled — the directory has no undo. A plan
   * command in it has no project to land in and refuses the batch as
   * `project_required` at its index.
   */
  runDirectory(actorId: string, commands: readonly PlanCommand[]): Promise<BatchOutcome> {
    return this.execute(null, actorId, commands);
  }

  /**
   * The turn covers the unit of work and nothing after it: the broadcast is a
   * push to gw-01 over the network, and a turn held across it would let one
   * slow gateway stall every write in the process. Proof:
   * `plan-commands.test.ts` › lets go of the write lock before the broadcast
   * leaves — with the announce inside `lock.run` the second batch waited on a
   * publish held open and the test timed out.
   *
   * That rule used to be this method's alone, and three services it calls broke
   * it by publishing from inside `applyAll`. They publish through
   * {@link DeferringBroadcaster} now, held for the length of the transaction and
   * drained here — so the rule is one mechanism rather than four conventions.
   *
   * **The hold sits inside `lock.run`, not around it**, and that is not a
   * detail: `execute` runs concurrently for every queued batch and only the lock
   * makes one-at-a-time true. Held around the lock, a second batch opened a hold
   * while the first still waited for it, and the queue is process-wide.
   * Proof: with `hold` moved outside, `lets go of the write lock before the
   * broadcast leaves` and `applies a rename queued behind a refused batch, after
   * it` both failed on `error: a batch is already holding announcements`;
   * watched 2026-09-02. That *symptom* is gone since TASK-256 made the queue
   * per-caller — two concurrent holds now each get their own — but the ordering
   * is unchanged and for a second reason the symptom never named: the hold has
   * to open inside the unit of work's act and close before its decision, so
   * what it collects is exactly the writes that decision is about.
   */
  private async execute(
    projectId: string | null,
    actorId: string,
    commands: readonly PlanCommand[],
  ): Promise<BatchOutcome> {
    const { announcements } = this.opts;
    interface Applied {
      applied: BatchOutcome | Collected<AppliedCommand[]>;
      pending: HeldAnnouncement[];
    }
    const done = await this.opts.uow.run<Applied>(async (): Promise<Decision<Applied>> => {
      // Proof: admitting one extra command returned404 instead of400 in the mounted cap-order case.
      const over = commands.at(MOST_COMMANDS_IN_A_BATCH);
      if (over !== undefined) {
        return {
          // Nothing was written, so there is nothing to undo — but the unit of
          // work opened for this act all the same, and `commit: false` is how
          // it is told to close without keeping anything. The transaction is
          // the unit of work's to open and to close; this method no longer
          // decides *when*, only *whether*.
          commit: false,
          value: {
            applied: {
              ok: false,
              at: MOST_COMMANDS_IN_A_BATCH,
              kind: over.kind,
              reason: 'too_many_commands',
            },
            pending: [],
          },
        };
      }
      const { workItems } = this.opts;
      const held = await announcements.hold(
        async (): Promise<BatchOutcome | Collected<AppliedCommand[]>> => {
          try {
            const collected = await workItems.collect(() =>
              this.applyAll(projectId, actorId, commands),
            );
            if (projectId !== null) {
              await workItems.recordCollected(projectId, actorId, collected.recordings);
            }
            return collected;
          } catch (cause) {
            if (cause instanceof Refused) {
              return { ok: false, at: cause.at, kind: cause.kind, ...cause.refusal };
            }
            throw cause;
          }
        },
      );
      // A refusal rolls the unit of work back, so whatever it queued describes
      // writes that will not be there. Dropped rather than sent.
      if ('ok' in held.result) {
        return { commit: false, value: { applied: held.result, pending: [] } };
      }
      return { commit: true, value: { applied: held.result, pending: held.pending } };
    });
    const { applied, pending } = done;
    if ('ok' in applied) return applied;
    // Out of the lock and after the commit, which is what the whole hold is for.
    await announcements.send(pending);
    const { workItems } = this.opts;
    if (projectId === null)
      return { ok: true, results: applied.result, undoable: false, redoable: false };
    if (applied.dirty) await workItems.announceTreeNow(projectId);
    const state = await workItems.undoState(projectId, actorId);
    return { ok: true, results: applied.result, ...state };
  }

  undo(projectId: string, actorId: string): Promise<UndoOutcome> {
    return this.walk(projectId, () => this.opts.workItems.undo(projectId, actorId));
  }

  redo(projectId: string, actorId: string): Promise<UndoOutcome> {
    return this.walk(projectId, () => this.opts.workItems.redo(projectId, actorId));
  }

  /**
   * One undo or redo as its own unit of work. A refusal rolls everything back —
   * a batch inverse that failed at step three has taken steps one and two back
   * too — and then discards the stale entry again through `afterRollback`,
   * because the service's own discard went with the rollback.
   */
  private async walk(projectId: string, step: () => Promise<UndoOutcome>): Promise<UndoOutcome> {
    const { workItems } = this.opts;
    // The step's own broadcast is collected rather than sent, for the reason
    // `execute` gives: the push happens after the turn is let go.
    const walked = await this.opts.uow.run<Collected<UndoOutcome>>(
      async (): Promise<Decision<Collected<UndoOutcome>>> => {
        const collected = await workItems.collect(step);
        if (collected.result.ok) return { commit: true, value: collected };
        const entryId = collected.result.entryId;
        return {
          commit: false,
          value: { ...collected, dirty: false },
          // The discard the refusal owes, in the one window it can be made: the
          // service's own went back with the rollback, and a discard issued
          // after `run` returns would be a second batch queueing behind this
          // one (D28).
          //
          // Through `workItems` rather than through the scope it is handed, and
          // the two are the same objects: this runner's services are the batch
          // graph, built over the **admitted** stores the unit of work hands
          // out. What the public journal would do instead is ask the
          // coordinator for the turn this `run` is still holding, which is a
          // deadlock — the kit's (k) watches that through `scope.stores`. When
          // the batch's graph is built per scope with its own collector (D24),
          // this becomes `servicesOver(scope.stores, …).workItems`.
          afterRollback:
            entryId === undefined
              ? undefined
              : async () => {
                  await workItems.discardEntry(entryId);
                },
        };
      },
    );
    if (walked.dirty) await workItems.announceTreeNow(projectId);
    return walked.result;
  }

  private async applyAll(
    scope: string | null,
    actorId: string,
    commands: readonly PlanCommand[],
  ): Promise<AppliedCommand[]> {
    const refs = new Map<string, string>();
    const results: AppliedCommand[] = [];
    for (const [index, command] of commands.entries()) {
      // A plan command in a batch with no project has nowhere to land.
      const projectId: string = (() => {
        if (scope !== null || DIRECTORY_KINDS.has(command.kind)) return scope ?? '';
        throw new Refused(index, command.kind, { reason: 'project_required' });
      })();
      // Typed on the binding, not inferred from the arrow: TypeScript narrows
      // after a call only when the callee's `never` is declared on the name.
      const refuse: (refusal: Refusal) => never = (refusal) => {
        throw new Refused(index, command.kind, refusal);
      };
      const id = (given: string | null | undefined, ref: string | undefined): string | null => {
        if (ref !== undefined) {
          const minted = refs.get(ref);
          if (minted === undefined) refuse({ reason: 'unknown_ref' });
          return minted;
        }
        return given ?? null;
      };
      const required = (given: string | undefined, ref: string | undefined): string => {
        const found = id(given, ref);
        if (found === null) refuse({ reason: 'missing_id' });
        return found;
      };
      const ids = (given: readonly string[] | undefined, named: readonly string[] | undefined) => [
        ...(given ?? []),
        ...(named ?? []).map((ref) => required(undefined, ref)),
      ];
      const mint = (ref: string | undefined, created: string): MintedBase => {
        if (ref !== undefined) {
          if (refs.has(ref)) refuse({ reason: 'duplicate_ref' });
          refs.set(ref, created);
        }
        return { index, ref, id: created };
      };
      const plain = (): AppliedBase => ({ index });
      const { workItems, directory, capacity, priorityBands } = this.opts;
      const refuseOutcome = (outcome: ServiceRefusal): never => {
        if (outcome.reason === 'taken')
          return refuse({ reason: 'taken', detail: { name: outcome.name } });
        if (outcome.reason === 'in_use')
          return refuse({ reason: 'in_use', detail: { usage: outcome.usage } });
        if (outcome.reason === 'deadline_before_project_start') {
          // Proof: deleting this guard threw Malformed deadline refusal resolved in the runner negative.
          if (typeof outcome.workItemId !== 'string' || typeof outcome.projectDayZero !== 'string')
            throw new Error('Deadline refusal requires work item and project day zero');
          return refuse({
            reason: outcome.reason,
            detail: { workItemId: outcome.workItemId, projectDayZero: outcome.projectDayZero },
          });
        }
        return refuse({ reason: outcome.reason });
      };
      const reasonOf = <T>(outcome: { ok: true; value: T } | ServiceRefusal): T =>
        outcome.ok ? outcome.value : refuseOutcome(outcome);
      const done = <K extends PlainKind>(kind: K, outcome: { ok: true } | ServiceRefusal) => {
        if (!outcome.ok) refuseOutcome(outcome);
        return { index, kind };
      };
      const entity = <K extends EntityKind, B extends AppliedBase>(
        kind: K,
        applied: B,
        value: CommandEntities[K],
      ) => ({ ...applied, kind, entity: value });

      switch (command.kind) {
        case 'createWorkItem': {
          if (command.ref !== undefined && refs.has(command.ref))
            refuse({ reason: 'duplicate_ref' });
          const created = reasonOf(
            await workItems.create(projectId, actorId, {
              parentId: id(command.parentId, command.parentRef),
              afterId: id(command.afterId, command.afterRef),
              ...(command.name === undefined ? {} : { name: command.name }),
              ...(command.notes === undefined ? {} : { notes: command.notes }),
              // Absent stays absent, exactly as `name` and `notes` do above, so
              // the service sees the three states the command carries: a number
              // written as given, an explicit `null` for an unprioritised row,
              // and nothing at all for the project's middle rung.
              ...(command.priority === undefined ? {} : { priority: command.priority }),
            }),
          );
          results.push({ ...mint(command.ref, created.id), kind: command.kind });
          break;
        }
        case 'patchWorkItem': {
          const { serviceRefs, tagRefs, teamRefs, typeRefs, ...patch } = command.patch;
          const resolved = {
            ...patch,
            ...(serviceRefs === undefined
              ? {}
              : { serviceIds: ids(patch.serviceIds, serviceRefs) }),
            ...(tagRefs === undefined ? {} : { tagIds: ids(patch.tagIds, tagRefs) }),
            ...(teamRefs === undefined ? {} : { teamIds: ids(patch.teamIds, teamRefs) }),
            ...(typeRefs === undefined ? {} : { typeIds: ids(patch.typeIds, typeRefs) }),
          };
          reasonOf(
            await workItems.patch(
              required(command.workItemId, command.workItemRef),
              actorId,
              resolved,
            ),
          );
          results.push({ ...plain(), kind: command.kind });
          break;
        }
        case 'moveWorkItem':
          reasonOf(
            await workItems.move(required(command.workItemId, command.workItemRef), actorId, {
              parentId: id(command.parentId, command.parentRef),
              afterId: id(command.afterId, command.afterRef),
            }),
          );
          results.push({ ...plain(), kind: command.kind });
          break;
        case 'duplicateWorkItem': {
          if (command.ref !== undefined && refs.has(command.ref))
            refuse({ reason: 'duplicate_ref' });
          const copy = reasonOf(
            await workItems.duplicate(required(command.workItemId, command.workItemRef), actorId),
          );
          results.push({ ...mint(command.ref, copy.id), kind: command.kind });
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
          results.push({ ...plain(), kind: command.kind });
          break;
        case 'setEstimate':
          reasonOf(
            await workItems.setEstimate(
              required(command.workItemId, command.workItemRef),
              actorId,
              command.stepId,
              command.days,
            ),
          );
          results.push({ ...plain(), kind: command.kind });
          break;
        case 'clearEstimate':
          reasonOf(
            await workItems.clearEstimate(
              required(command.workItemId, command.workItemRef),
              actorId,
              command.stepId,
            ),
          );
          results.push({ ...plain(), kind: command.kind });
          break;
        case 'setActual':
          reasonOf(
            await workItems.setActual(
              required(command.workItemId, command.workItemRef),
              actorId,
              command.stepId,
              command.days,
            ),
          );
          results.push({ ...plain(), kind: command.kind });
          break;
        case 'clearActual':
          reasonOf(
            await workItems.clearActual(
              required(command.workItemId, command.workItemRef),
              actorId,
              command.stepId,
            ),
          );
          results.push({ ...plain(), kind: command.kind });
          break;
        case 'setProgress':
          reasonOf(
            await workItems.setProgress(
              required(command.workItemId, command.workItemRef),
              actorId,
              command.stepId,
              command.state,
            ),
          );
          results.push({ ...plain(), kind: command.kind });
          break;
        case 'clearProgress':
          reasonOf(
            await workItems.clearProgress(
              required(command.workItemId, command.workItemRef),
              actorId,
              command.stepId,
            ),
          );
          results.push({ ...plain(), kind: command.kind });
          break;
        case 'setMeasure':
          reasonOf(
            await workItems.setMeasure(
              required(command.workItemId, command.workItemRef),
              actorId,
              command.stepId,
              command.metric,
              command.value,
            ),
          );
          results.push({ ...plain(), kind: command.kind });
          break;
        case 'clearMeasure':
          reasonOf(
            await workItems.clearMeasure(
              required(command.workItemId, command.workItemRef),
              actorId,
              command.stepId,
              command.metric,
            ),
          );
          results.push({ ...plain(), kind: command.kind });
          break;
        case 'setAssignee':
          reasonOf(
            await workItems.assign(
              required(command.workItemId, command.workItemRef),
              actorId,
              command.stepId,
              id(command.personId, command.personRef),
            ),
          );
          results.push({ ...plain(), kind: command.kind });
          break;
        case 'addDependency':
          reasonOf(
            await workItems.addDependency(
              required(command.workItemId, command.workItemRef),
              actorId,
              required(command.predecessorId, command.predecessorRef),
            ),
          );
          results.push({ ...plain(), kind: command.kind });
          break;
        case 'removeDependency':
          reasonOf(
            await workItems.removeDependency(
              required(command.workItemId, command.workItemRef),
              actorId,
              required(command.predecessorId, command.predecessorRef),
            ),
          );
          results.push({ ...plain(), kind: command.kind });
          break;
        case 'freezeProject':
          reasonOf(await workItems.freeze(projectId, actorId));
          results.push({ ...plain(), kind: command.kind });
          break;
        case 'unfreezeProject':
          reasonOf(await workItems.unfreezeProject(projectId, actorId));
          results.push({ ...plain(), kind: command.kind });
          break;
        case 'unfreezeWorkItem':
          reasonOf(
            await workItems.unfreeze(required(command.workItemId, command.workItemRef), actorId),
          );
          results.push({ ...plain(), kind: command.kind });
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
          results.push({ ...plain(), kind: command.kind });
          break;
        case 'setPriorityBands':
          reasonOf(await priorityBands.set(projectId, actorId, command.bands));
          results.push({ ...plain(), kind: command.kind });
          break;
        case 'createTeam': {
          if (command.ref !== undefined && refs.has(command.ref))
            refuse({ reason: 'duplicate_ref' });
          const team = await directory.addTeam(actorId, command.name);
          if (team === null) refuse({ reason: 'name_required' });
          results.push(entity(command.kind, mint(command.ref, team.id), team));
          break;
        }
        case 'patchTeam':
          results.push(
            entity(
              command.kind,
              plain(),
              reasonOf(
                await directory.patchTeam(
                  required(command.teamId, command.teamRef),
                  actorId,
                  command.patch,
                ),
              ),
            ),
          );
          break;
        case 'deleteTeam':
          results.push(
            done(
              command.kind,
              await directory.removeTeam(
                required(command.teamId, command.teamRef),
                actorId,
                command.cascade ?? false,
              ),
            ),
          );
          break;
        case 'createPerson': {
          if (command.ref !== undefined && refs.has(command.ref))
            refuse({ reason: 'duplicate_ref' });
          const person = reasonOf(
            await directory.addPerson(
              actorId,
              command.name,
              ids(command.teamIds, command.teamRefs),
            ),
          );
          results.push(entity(command.kind, mint(command.ref, person.id), person));
          break;
        }
        case 'patchPerson':
          results.push(
            entity(
              command.kind,
              plain(),
              reasonOf(
                await directory.patchPerson(
                  required(command.personId, command.personRef),
                  actorId,
                  command.patch,
                ),
              ),
            ),
          );
          break;
        case 'deletePerson':
          results.push(
            done(
              command.kind,
              await directory.removePerson(
                required(command.personId, command.personRef),
                actorId,
                command.cascade ?? false,
              ),
            ),
          );
          break;
        case 'createTag': {
          if (command.ref !== undefined && refs.has(command.ref))
            refuse({ reason: 'duplicate_ref' });
          const tag = await directory.addTag(actorId, command.name);
          if (tag === null) refuse({ reason: 'name_required' });
          results.push(entity(command.kind, mint(command.ref, tag.id), tag));
          break;
        }
        case 'patchTag':
          results.push(
            entity(
              command.kind,
              plain(),
              reasonOf(
                await directory.renameTag(
                  required(command.tagId, command.tagRef),
                  actorId,
                  command.name,
                ),
              ),
            ),
          );
          break;
        case 'deleteTag':
          results.push(
            done(
              command.kind,
              await directory.removeTag(
                required(command.tagId, command.tagRef),
                actorId,
                command.cascade ?? false,
              ),
            ),
          );
          break;
        // The tag trio, one dimension over, line for line — including
        // `createWorkItemType` refusing a duplicate ref before it writes, so a
        // batch naming one ref twice cannot mint two rows under one name.
        case 'createWorkItemType': {
          if (command.ref !== undefined && refs.has(command.ref))
            refuse({ reason: 'duplicate_ref' });
          const workItemType = await directory.addWorkItemType(actorId, command.name);
          if (workItemType === null) refuse({ reason: 'name_required' });
          results.push(entity(command.kind, mint(command.ref, workItemType.id), workItemType));
          break;
        }
        case 'patchWorkItemType':
          results.push(
            entity(
              command.kind,
              plain(),
              reasonOf(
                await directory.renameWorkItemType(
                  required(command.typeId, command.typeRef),
                  actorId,
                  command.name,
                ),
              ),
            ),
          );
          break;
        case 'deleteWorkItemType':
          results.push(
            done(
              command.kind,
              await directory.removeWorkItemType(
                required(command.typeId, command.typeRef),
                actorId,
                command.cascade ?? false,
              ),
            ),
          );
          break;
        case 'createService': {
          if (command.ref !== undefined && refs.has(command.ref))
            refuse({ reason: 'duplicate_ref' });
          const service = await directory.addService(actorId, command.name);
          if (service === null) refuse({ reason: 'name_required' });
          results.push(entity(command.kind, mint(command.ref, service.id), service));
          break;
        }
        case 'patchService':
          results.push(
            entity(
              command.kind,
              plain(),
              reasonOf(
                await directory.renameService(
                  required(command.serviceId, command.serviceRef),
                  actorId,
                  command.name,
                ),
              ),
            ),
          );
          break;
        case 'deleteService':
          results.push(
            done(
              command.kind,
              await directory.removeService(
                required(command.serviceId, command.serviceRef),
                actorId,
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
