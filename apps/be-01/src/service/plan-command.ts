import type { RoleState } from '@wbs/domain';
import type { PriorityBand } from '@wbs/domain/priority-band';

import type { PersonPatch, TeamPatch, WorkItemPatch } from '../repository';
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
    }
  | ({
      kind: 'patchWorkItem';
      patch: WorkItemPatch & { serviceRefs?: string[]; tagRefs?: string[]; teamRefs?: string[] };
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
  | ({ kind: 'setEstimate'; roleId: string; days: Days } & Target)
  | ({ kind: 'clearEstimate'; roleId: string } & Target)
  | ({ kind: 'setActual'; roleId: string; days: number } & Target)
  | ({ kind: 'clearActual'; roleId: string } & Target)
  | ({ kind: 'setProgress'; roleId: string; state: RoleState } & Target)
  | ({ kind: 'clearProgress'; roleId: string } & Target)
  | ({ kind: 'setMeasure'; roleId: string; metric: string; value: number } & Target)
  | ({ kind: 'clearMeasure'; roleId: string; metric: string } & Target)
  | ({ kind: 'setAssignee'; roleId: string; personId: string | null; personRef?: string } & Target)
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
  | { kind: 'createService'; ref?: string; name: string }
  | { kind: 'patchService'; serviceId?: string; serviceRef?: string; name: string }
  | { kind: 'deleteService'; serviceId?: string; serviceRef?: string; cascade?: boolean };

/** A step aimed at one work item: by id, or by the ref an earlier step minted. */
interface Target {
  workItemId?: string;
  workItemRef?: string;
}

export type PlanCommandKind = PlanCommand['kind'];

/** Every kind, for the document and for the parser — the union, enumerated once. */
export const PLAN_COMMAND_KINDS: readonly PlanCommandKind[] = [
  'createWorkItem',
  'patchWorkItem',
  'moveWorkItem',
  'duplicateWorkItem',
  'deleteWorkItem',
  'setEstimate',
  'clearEstimate',
  'setActual',
  'clearActual',
  'setProgress',
  'clearProgress',
  'setMeasure',
  'clearMeasure',
  'setAssignee',
  'addDependency',
  'removeDependency',
  'freezeProject',
  'unfreezeProject',
  'unfreezeWorkItem',
  'setCapacity',
  'setPriorityBands',
  'createTeam',
  'patchTeam',
  'deleteTeam',
  'createPerson',
  'patchPerson',
  'deletePerson',
  'createTag',
  'patchTag',
  'deleteTag',
  'createService',
  'patchService',
  'deleteService',
];

/** The most commands one batch may carry. */
export const MOST_COMMANDS_IN_A_BATCH = 200;
