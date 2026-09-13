import type { PlanCommandKind } from '@wbs/contracts';
import { commandDefinitions } from '@wbs/contracts';

import type { PlanCommand } from './plan-command';
import type {
  AppliedBase,
  AppliedCommand,
  MintedBase,
  PlanCommandServices,
  Refusal,
  ServiceRefusal,
} from './plan-commands';

export type CommandFor<K extends PlanCommandKind> = PlanCommand & { kind: K };
export type AppliedFor<K extends PlanCommandKind> = AppliedCommand & { kind: K };
export type CommandBindings = {
  [K in PlanCommandKind]: (
    command: CommandFor<K>,
    context: CommandContext,
  ) => Promise<AppliedFor<K>>;
};

/** Stops one binding while retaining the command position and typed refusal. */
export class CommandRefused extends Error {
  constructor(
    readonly at: number,
    readonly kind: PlanCommandKind,
    readonly refusal: Refusal,
  ) {
    super(`${kind} at ${String(at)}: ${refusal.reason}`);
  }
}

/**
 * The batch-local authority shared by one command binding: actor and project,
 * ref lookup/minting, applied position, and service-refusal translation.
 */
export class CommandContext {
  constructor(
    readonly actorId: string,
    readonly projectId: string | null,
    readonly index: number,
    private readonly kind: PlanCommandKind,
    private readonly refs: Map<string, string>,
  ) {
    // Proof: removing registry-scope admission let a directory batch unfreeze a real plan row
    // and commit its preceding tag instead of refusing `project_required` at index 1.
    if (projectId === null && commandDefinitions[kind].scope === 'project') {
      this.refuse({ reason: 'project_required' });
    }
  }

  refuse(refusal: Refusal): never {
    throw new CommandRefused(this.index, this.kind, refusal);
  }

  requireProjectId(): string {
    if (this.projectId === null) this.refuse({ reason: 'project_required' });
    return this.projectId;
  }

  id(given: string | null | undefined, ref: string | undefined): string | null {
    if (ref !== undefined) {
      const minted = this.refs.get(ref);
      if (minted === undefined) this.refuse({ reason: 'unknown_ref' });
      return minted;
    }
    return given ?? null;
  }

  required(given: string | undefined, ref: string | undefined): string {
    const found = this.id(given, ref);
    if (found === null) this.refuse({ reason: 'missing_id' });
    return found;
  }

  ids(given: readonly string[] | undefined, named: readonly string[] | undefined): string[] {
    return [...(given ?? []), ...(named ?? []).map((ref) => this.required(undefined, ref))];
  }

  assertRefAvailable(ref: string | undefined): void {
    if (ref !== undefined && this.refs.has(ref)) this.refuse({ reason: 'duplicate_ref' });
  }

  mint(ref: string | undefined, created: string): MintedBase {
    if (ref !== undefined) {
      this.assertRefAvailable(ref);
      this.refs.set(ref, created);
    }
    return { index: this.index, ref, id: created };
  }

  plain(): AppliedBase {
    return { index: this.index };
  }

  accept(outcome: { ok: true } | ServiceRefusal): void {
    if (!outcome.ok) this.refuseOutcome(outcome);
  }

  value<T>(outcome: { ok: true; value: T } | ServiceRefusal): T {
    return outcome.ok ? outcome.value : this.refuseOutcome(outcome);
  }

  requireValue<T>(value: T | null, refusal: Refusal): T {
    if (value === null) this.refuse(refusal);
    return value;
  }

  private refuseOutcome(outcome: ServiceRefusal): never {
    if (outcome.reason === 'taken') {
      return this.refuse({ reason: 'taken', detail: { name: outcome.name } });
    }
    if (outcome.reason === 'in_use') {
      return this.refuse({ reason: 'in_use', detail: { usage: outcome.usage } });
    }
    if (outcome.reason === 'deadline_before_project_start') {
      // Proof: deleting this guard threw Malformed deadline refusal resolved in the runner negative.
      if (typeof outcome.workItemId !== 'string' || typeof outcome.projectDayZero !== 'string') {
        throw new Error('Deadline refusal requires work item and project day zero');
      }
      return this.refuse({
        reason: outcome.reason,
        detail: { workItemId: outcome.workItemId, projectDayZero: outcome.projectDayZero },
      });
    }
    return this.refuse({ reason: outcome.reason });
  }
}

type NamedDirectoryCreateKind = 'createTag' | 'createWorkItemType' | 'createService';
type NamedDirectoryPatchKind = 'patchTag' | 'patchWorkItemType' | 'patchService';
type NamedDirectoryDeleteKind = 'deleteTag' | 'deleteWorkItemType' | 'deleteService';

async function createDirectoryEntry<
  Kind extends NamedDirectoryCreateKind,
  Entity extends { id: string },
>(
  context: CommandContext,
  command: { kind: Kind; ref?: string; name: string },
  create: (actorId: string, name: string) => Promise<Entity | null>,
): Promise<MintedBase & { kind: Kind; entity: Entity }> {
  context.assertRefAvailable(command.ref);
  const entity = context.requireValue(await create(context.actorId, command.name), {
    reason: 'name_required',
  });
  return { ...context.mint(command.ref, entity.id), kind: command.kind, entity };
}

async function patchDirectoryEntry<Kind extends NamedDirectoryPatchKind, Entity>(
  context: CommandContext,
  command: { kind: Kind; name: string },
  id: string | undefined,
  ref: string | undefined,
  patch: (
    id: string,
    actorId: string,
    name: string,
  ) => Promise<{ ok: true; value: Entity } | ServiceRefusal>,
): Promise<AppliedBase & { kind: Kind; entity: Entity }> {
  const entity = context.value(
    await patch(context.required(id, ref), context.actorId, command.name),
  );
  return { ...context.plain(), kind: command.kind, entity };
}

async function deleteDirectoryEntry<Kind extends NamedDirectoryDeleteKind>(
  context: CommandContext,
  command: { kind: Kind; cascade?: boolean },
  id: string | undefined,
  ref: string | undefined,
  remove: (id: string, actorId: string, cascade: boolean) => Promise<{ ok: true } | ServiceRefusal>,
): Promise<AppliedBase & { kind: Kind }> {
  context.accept(
    await remove(context.required(id, ref), context.actorId, command.cascade ?? false),
  );
  return { ...context.plain(), kind: command.kind };
}

/** Builds one command handler per registry kind over the batch's admitted service graph. */
export function bindCommands(graph: PlanCommandServices): CommandBindings {
  const { workItems, directory, capacity, priorityBands } = graph;
  return {
    createWorkItem: async (command, context) => {
      // Proof: deferring this check until minting let the invalid parent reach the service first
      // and returned `not_found` instead of `duplicate_ref` for the second create.
      context.assertRefAvailable(command.ref);
      const created = context.value(
        await workItems.create(context.requireProjectId(), context.actorId, {
          parentId: context.id(command.parentId, command.parentRef),
          afterId: context.id(command.afterId, command.afterRef),
          ...(command.name === undefined ? {} : { name: command.name }),
          ...(command.notes === undefined ? {} : { notes: command.notes }),
          ...(command.priority === undefined ? {} : { priority: command.priority }),
        }),
      );
      return { ...context.mint(command.ref, created.id), kind: command.kind };
    },
    patchWorkItem: async (command, context) => {
      const { serviceRefs, tagRefs, teamRefs, typeRefs, ...patch } = command.patch;
      const resolved = {
        ...patch,
        ...(serviceRefs === undefined
          ? {}
          : { serviceIds: context.ids(patch.serviceIds, serviceRefs) }),
        ...(tagRefs === undefined ? {} : { tagIds: context.ids(patch.tagIds, tagRefs) }),
        ...(teamRefs === undefined ? {} : { teamIds: context.ids(patch.teamIds, teamRefs) }),
        ...(typeRefs === undefined ? {} : { typeIds: context.ids(patch.typeIds, typeRefs) }),
      };
      context.value(
        await workItems.patch(
          context.required(command.workItemId, command.workItemRef),
          context.actorId,
          resolved,
        ),
      );
      return { ...context.plain(), kind: command.kind };
    },
    moveWorkItem: async (command, context) => {
      context.value(
        await workItems.move(
          context.required(command.workItemId, command.workItemRef),
          context.actorId,
          {
            parentId: context.id(command.parentId, command.parentRef),
            afterId: context.id(command.afterId, command.afterRef),
          },
        ),
      );
      return { ...context.plain(), kind: command.kind };
    },
    duplicateWorkItem: async (command, context) => {
      context.assertRefAvailable(command.ref);
      const copy = context.value(
        await workItems.duplicate(
          context.required(command.workItemId, command.workItemRef),
          context.actorId,
        ),
      );
      return { ...context.mint(command.ref, copy.id), kind: command.kind };
    },
    deleteWorkItem: async (command, context) => {
      context.value(
        await workItems.remove(
          context.required(command.workItemId, command.workItemRef),
          context.actorId,
          command.strategy ?? null,
        ),
      );
      return { ...context.plain(), kind: command.kind };
    },
    setEstimate: async (command, context) => {
      context.value(
        await workItems.setEstimate(
          context.required(command.workItemId, command.workItemRef),
          context.actorId,
          command.stepId,
          command.days,
        ),
      );
      return { ...context.plain(), kind: command.kind };
    },
    clearEstimate: async (command, context) => {
      context.value(
        await workItems.clearEstimate(
          context.required(command.workItemId, command.workItemRef),
          context.actorId,
          command.stepId,
        ),
      );
      return { ...context.plain(), kind: command.kind };
    },
    setActual: async (command, context) => {
      context.value(
        await workItems.setActual(
          context.required(command.workItemId, command.workItemRef),
          context.actorId,
          command.stepId,
          command.days,
        ),
      );
      return { ...context.plain(), kind: command.kind };
    },
    clearActual: async (command, context) => {
      context.value(
        await workItems.clearActual(
          context.required(command.workItemId, command.workItemRef),
          context.actorId,
          command.stepId,
        ),
      );
      return { ...context.plain(), kind: command.kind };
    },
    setProgress: async (command, context) => {
      context.value(
        await workItems.setProgress(
          context.required(command.workItemId, command.workItemRef),
          context.actorId,
          command.stepId,
          command.state,
        ),
      );
      return { ...context.plain(), kind: command.kind };
    },
    clearProgress: async (command, context) => {
      context.value(
        await workItems.clearProgress(
          context.required(command.workItemId, command.workItemRef),
          context.actorId,
          command.stepId,
        ),
      );
      return { ...context.plain(), kind: command.kind };
    },
    setStatus: async (command, context) => {
      context.value(
        await workItems.setStatus(
          context.required(command.workItemId, command.workItemRef),
          context.actorId,
          command.status,
          command.on,
        ),
      );
      return { ...context.plain(), kind: command.kind };
    },
    setMeasure: async (command, context) => {
      context.value(
        await workItems.setMeasure(
          context.required(command.workItemId, command.workItemRef),
          context.actorId,
          command.stepId,
          command.metric,
          command.value,
        ),
      );
      return { ...context.plain(), kind: command.kind };
    },
    clearMeasure: async (command, context) => {
      context.value(
        await workItems.clearMeasure(
          context.required(command.workItemId, command.workItemRef),
          context.actorId,
          command.stepId,
          command.metric,
        ),
      );
      return { ...context.plain(), kind: command.kind };
    },
    setAssignee: async (command, context) => {
      context.value(
        await workItems.assign(
          context.required(command.workItemId, command.workItemRef),
          context.actorId,
          command.stepId,
          context.id(command.personId, command.personRef),
        ),
      );
      return { ...context.plain(), kind: command.kind };
    },
    addDependency: async (command, context) => {
      context.value(
        await workItems.addDependency(
          context.required(command.workItemId, command.workItemRef),
          context.actorId,
          context.required(command.predecessorId, command.predecessorRef),
        ),
      );
      return { ...context.plain(), kind: command.kind };
    },
    removeDependency: async (command, context) => {
      context.value(
        await workItems.removeDependency(
          context.required(command.workItemId, command.workItemRef),
          context.actorId,
          context.required(command.predecessorId, command.predecessorRef),
        ),
      );
      return { ...context.plain(), kind: command.kind };
    },
    arrangeBySchedule: async (command, context) => {
      context.value(await workItems.arrangeBySchedule(context.requireProjectId(), context.actorId));
      return { ...context.plain(), kind: command.kind };
    },
    freezeProject: async (command, context) => {
      context.value(await workItems.freeze(context.requireProjectId(), context.actorId));
      return { ...context.plain(), kind: command.kind };
    },
    unfreezeProject: async (command, context) => {
      context.value(await workItems.unfreezeProject(context.requireProjectId(), context.actorId));
      return { ...context.plain(), kind: command.kind };
    },
    unfreezeWorkItem: async (command, context) => {
      context.value(
        await workItems.unfreeze(
          context.required(command.workItemId, command.workItemRef),
          context.actorId,
        ),
      );
      return { ...context.plain(), kind: command.kind };
    },
    setCapacity: async (command, context) => {
      context.value(
        await capacity.set(
          context.requireProjectId(),
          context.actorId,
          context.required(command.teamId, command.teamRef),
          command.size,
        ),
      );
      return { ...context.plain(), kind: command.kind };
    },
    setPriorityBands: async (command, context) => {
      context.value(
        await priorityBands.set(context.requireProjectId(), context.actorId, command.bands),
      );
      return { ...context.plain(), kind: command.kind };
    },
    createTeam: async (command, context) => {
      context.assertRefAvailable(command.ref);
      const team = context.requireValue(await directory.addTeam(context.actorId, command.name), {
        reason: 'name_required',
      });
      return {
        ...context.mint(command.ref, team.id),
        kind: command.kind,
        entity: team,
      };
    },
    patchTeam: async (command, context) => {
      const team = context.value(
        await directory.patchTeam(
          context.required(command.teamId, command.teamRef),
          context.actorId,
          command.patch,
        ),
      );
      return { ...context.plain(), kind: command.kind, entity: team };
    },
    deleteTeam: async (command, context) => {
      context.accept(
        await directory.removeTeam(
          context.required(command.teamId, command.teamRef),
          context.actorId,
          command.cascade ?? false,
        ),
      );
      return { ...context.plain(), kind: command.kind };
    },
    createPerson: async (command, context) => {
      context.assertRefAvailable(command.ref);
      const person = context.value(
        await directory.addPerson(
          context.actorId,
          command.name,
          context.ids(command.teamIds, command.teamRefs),
        ),
      );
      return {
        ...context.mint(command.ref, person.id),
        kind: command.kind,
        entity: person,
      };
    },
    patchPerson: async (command, context) => {
      const person = context.value(
        await directory.patchPerson(
          context.required(command.personId, command.personRef),
          context.actorId,
          command.patch,
        ),
      );
      return { ...context.plain(), kind: command.kind, entity: person };
    },
    deletePerson: async (command, context) => {
      context.accept(
        await directory.removePerson(
          context.required(command.personId, command.personRef),
          context.actorId,
          command.cascade ?? false,
        ),
      );
      return { ...context.plain(), kind: command.kind };
    },
    createTag: (command, context) =>
      createDirectoryEntry(context, command, (actorId, name) => directory.addTag(actorId, name)),
    patchTag: (command, context) =>
      patchDirectoryEntry(context, command, command.tagId, command.tagRef, (id, actorId, name) =>
        directory.renameTag(id, actorId, name),
      ),
    deleteTag: (command, context) =>
      deleteDirectoryEntry(
        context,
        command,
        command.tagId,
        command.tagRef,
        (id, actorId, cascade) => directory.removeTag(id, actorId, cascade),
      ),
    createWorkItemType: (command, context) =>
      createDirectoryEntry(context, command, (actorId, name) =>
        directory.addWorkItemType(actorId, name),
      ),
    patchWorkItemType: (command, context) =>
      patchDirectoryEntry(context, command, command.typeId, command.typeRef, (id, actorId, name) =>
        directory.renameWorkItemType(id, actorId, name),
      ),
    deleteWorkItemType: (command, context) =>
      deleteDirectoryEntry(
        context,
        command,
        command.typeId,
        command.typeRef,
        (id, actorId, cascade) => directory.removeWorkItemType(id, actorId, cascade),
      ),
    createService: (command, context) =>
      createDirectoryEntry(context, command, (actorId, name) =>
        directory.addService(actorId, name),
      ),
    patchService: (command, context) =>
      patchDirectoryEntry(
        context,
        command,
        command.serviceId,
        command.serviceRef,
        (id, actorId, name) => directory.renameService(id, actorId, name),
      ),
    deleteService: (command, context) =>
      deleteDirectoryEntry(
        context,
        command,
        command.serviceId,
        command.serviceRef,
        (id, actorId, cascade) => directory.removeService(id, actorId, cascade),
      ),
  };
}

/** Calls the binding selected by the command's own discriminator. */
export function applyCommand<K extends PlanCommandKind>(
  bindings: CommandBindings,
  command: CommandFor<K>,
  context: CommandContext,
): Promise<AppliedFor<K>> {
  return bindings[command.kind](command, context);
}
