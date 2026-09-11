import type { StepState } from '@wbs/domain';
import type { PriorityBand } from '@wbs/domain/priority-band';

import type { PersonPatch, TeamPatch } from '../ports/directory-store';
import type { WorkItemPatch } from '../ports/work-item-store';
import type { Days } from './roll-up';
import type { DeleteStrategy } from './work-item.service';

/**
 * One step of a {@link Command batch}: exactly the write one retired route
 * took, with the ids the route carried in its path as fields, and every id
 * field also offered as a `…Ref` naming something an earlier step created.
 *
 * `kind` is the discriminator and the word the API answers with when it refuses
 * a step. A create may carry `ref`, the name later steps use for what it made.
 */
export type PlanCommand =
  | {
      kind: 'createWorkItem';
      ref?: string;
      parentId?: string | null;
      parentRef?: string;
      afterId?: string | null;
      afterRef?: string;
      name?: string;
      notes?: string;
      /**
       * Absent takes the project's middle rung; a number is written as given;
       * an explicit `null` creates the item unprioritised. This field is
       * `CreateWorkItem.priority` in `work-item.service.ts` on the wire, and the
       * three states are documented there.
       */
      priority?: number | null;
    }
  | ({
      kind: 'patchWorkItem';
      patch: WorkItemPatch & {
        serviceRefs?: string[];
        tagRefs?: string[];
        teamRefs?: string[];
        typeRefs?: string[];
      };
    } & Target)
  | ({
      kind: 'moveWorkItem';
      parentId?: string | null;
      parentRef?: string;
      afterId?: string | null;
      afterRef?: string;
    } & Target)
  | ({ kind: 'duplicateWorkItem'; ref?: string } & Target)
  | ({ kind: 'deleteWorkItem'; strategy?: DeleteStrategy } & Target)
  | ({ kind: 'setEstimate'; stepId: string; days: Days } & Target)
  | ({ kind: 'clearEstimate'; stepId: string } & Target)
  | ({ kind: 'setActual'; stepId: string; days: number } & Target)
  | ({ kind: 'clearActual'; stepId: string } & Target)
  | ({ kind: 'setProgress'; stepId: string; state: StepState } & Target)
  | ({ kind: 'clearProgress'; stepId: string } & Target)
  | ({ kind: 'setMeasure'; stepId: string; metric: string; value: number } & Target)
  | ({ kind: 'clearMeasure'; stepId: string; metric: string } & Target)
  | ({ kind: 'setAssignee'; stepId: string; personId: string | null; personRef?: string } & Target)
  | ({ kind: 'addDependency'; predecessorId?: string; predecessorRef?: string } & Target)
  | ({ kind: 'removeDependency'; predecessorId?: string; predecessorRef?: string } & Target)
  | { kind: 'freezeProject' }
  | { kind: 'unfreezeProject' }
  | ({ kind: 'unfreezeWorkItem' } & Target)
  | { kind: 'setCapacity'; teamId?: string; teamRef?: string; size: number | null }
  | { kind: 'setPriorityBands'; bands: PriorityBand[] }
  | { kind: 'createTeam'; ref?: string; name: string }
  | { kind: 'patchTeam'; teamId?: string; teamRef?: string; patch: TeamPatch }
  | { kind: 'deleteTeam'; teamId?: string; teamRef?: string; cascade?: boolean }
  | {
      kind: 'createPerson';
      ref?: string;
      name: string;
      teamIds?: readonly string[];
      teamRefs?: readonly string[];
    }
  | {
      kind: 'patchPerson';
      personId?: string;
      personRef?: string;
      patch: Omit<PersonPatch, 'kind'> & { kind?: string };
    }
  | { kind: 'deletePerson'; personId?: string; personRef?: string; cascade?: boolean }
  | { kind: 'createTag'; ref?: string; name: string }
  | { kind: 'patchTag'; tagId?: string; tagRef?: string; name: string }
  | { kind: 'deleteTag'; tagId?: string; tagRef?: string; cascade?: boolean }
  | { kind: 'createWorkItemType'; ref?: string; name: string }
  | { kind: 'patchWorkItemType'; typeId?: string; typeRef?: string; name: string }
  | { kind: 'deleteWorkItemType'; typeId?: string; typeRef?: string; cascade?: boolean }
  | { kind: 'createService'; ref?: string; name: string }
  | { kind: 'patchService'; serviceId?: string; serviceRef?: string; name: string }
  | { kind: 'deleteService'; serviceId?: string; serviceRef?: string; cascade?: boolean };

/** A step aimed at one work item: by id, or by the ref an earlier step minted. */
interface Target {
  workItemId?: string;
  workItemRef?: string;
}

export type PlanCommandKind = PlanCommand['kind'];

/**
 * Every kind, for the document and for the parser — the union, enumerated once
 * and **derived** rather than written out beside it.
 *
 * The enumeration was a hand-written array typed `readonly PlanCommandKind[]`,
 * which is a check that cannot fail in the direction that matters: a kind added
 * to the union and forgotten here type-checks perfectly, because a subset of a
 * union is a valid array of it. The consequences are silent — `parseCommand`
 * refuses the new kind as `unknown_kind`, and
 * a document derived from the same incomplete list would be short by one too.
 *
 * `satisfies Record<PlanCommandKind, true>` closes both directions: a missing
 * kind is a missing property and an invented one is an excess property, and
 * either is a typecheck error at this line.
 *
 * Proof: `deleteService` removed from the record, `nx typecheck be-01` failed on
 * `plan-command.ts(160,3): error TS1360: Type '{ createWorkItem: true; … }' does
 * not satisfy the expected type 'Record<"createWorkItem" | … | "deleteService",
 * true>'` — the union's own arms listed back as what the record is short of.
 * Watched 2026-09-02.
 */
const EVERY_KIND = {
  createWorkItem: true,
  patchWorkItem: true,
  moveWorkItem: true,
  duplicateWorkItem: true,
  deleteWorkItem: true,
  setEstimate: true,
  clearEstimate: true,
  setActual: true,
  clearActual: true,
  setProgress: true,
  clearProgress: true,
  setMeasure: true,
  clearMeasure: true,
  setAssignee: true,
  addDependency: true,
  removeDependency: true,
  freezeProject: true,
  unfreezeProject: true,
  unfreezeWorkItem: true,
  setCapacity: true,
  setPriorityBands: true,
  createTeam: true,
  patchTeam: true,
  deleteTeam: true,
  createPerson: true,
  patchPerson: true,
  deletePerson: true,
  createTag: true,
  patchTag: true,
  deleteTag: true,
  createWorkItemType: true,
  patchWorkItemType: true,
  deleteWorkItemType: true,
  createService: true,
  patchService: true,
  deleteService: true,
} satisfies Record<PlanCommandKind, true>;

/**
 * The kinds, in the order they are written above — which is the order the
 * commands document lists them in.
 */
export const PLAN_COMMAND_KINDS: readonly PlanCommandKind[] = Object.keys(
  EVERY_KIND,
) as PlanCommandKind[];

/** The most commands one batch may carry. */
export const MOST_COMMANDS_IN_A_BATCH = 200;
