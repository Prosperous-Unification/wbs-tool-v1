import { type Type, type } from 'arktype';

export type CommandScope = 'project' | 'directory';

type SchemaKind<Schema extends Type> = Schema['infer'] extends {
  kind: infer Kind extends string;
}
  ? Kind
  : never;

type MatchingKind<Kind extends string, Schema extends Type> =
  SchemaKind<Schema> extends Kind ? (Kind extends SchemaKind<Schema> ? unknown : never) : never;

interface CommandDefinition<Schema extends Type> {
  readonly schema: Schema;
  readonly scope: CommandScope;
  readonly description: string;
}

export function defineCommand<const Kind extends string, const Schema extends Type>(
  kind: Kind,
  definition: CommandDefinition<Schema> & MatchingKind<Kind, Schema>,
): CommandDefinition<Schema> {
  return {
    ...definition,
    schema: definition.schema.describe(definition.description),
  };
}

const target = { 'workItemId?': 'string', 'workItemRef?': 'string' } as const;
const placement = {
  'parentId?': 'string | null',
  'parentRef?': 'string',
  'afterId?': 'string | null',
  'afterRef?': 'string',
} as const;
const reference = { 'ref?': 'string' } as const;
const named = { ...reference, name: 'string' } as const;
const step = { ...target, stepId: 'string' } as const;
const predecessor = {
  ...target,
  'predecessorId?': 'string',
  'predecessorRef?': 'string',
} as const;
const team = { 'teamId?': 'string', 'teamRef?': 'string' } as const;
const person = { 'personId?': 'string', 'personRef?': 'string' } as const;
const tag = { 'tagId?': 'string', 'tagRef?': 'string' } as const;
const service = { 'serviceId?': 'string', 'serviceRef?': 'string' } as const;
const workItemType = { 'typeId?': 'string', 'typeRef?': 'string' } as const;
// Proof: admitting frozenNumber failed nested structural validation and made its type fixture report TS2578.
const workItemPatch = type({
  'name?': 'string',
  'notes?': 'string',
  'startNoEarlierThan?': 'string | null',
  'deadline?': 'string | null',
  'factStart?': 'string | null',
  'factEnd?': 'string | null',
  'startNoEarlierThanReason?': 'string | null',
  'priority?': 'number | null',
  'serviceTeamId?': 'string | null',
  'maxParallel?': 'number | null',
  'teamIds?': 'string[]',
  'tagIds?': 'string[]',
  'serviceIds?': 'string[]',
  'typeIds?': 'string[]',
  'teamRefs?': 'string[]',
  'tagRefs?': 'string[]',
  'serviceRefs?': 'string[]',
  'typeRefs?': 'string[]',
  'externalRefs?': type({ systemId: 'string', url: 'string', 'name?': 'string' }).array(),
});

export const commandDefinitions = {
  createWorkItem: defineCommand('createWorkItem', {
    schema: type({
      kind: "'createWorkItem'",
      ...reference,
      ...placement,
      'name?': 'string',
      'notes?': 'string',
      'priority?': 'number | null',
    }),
    scope: 'project',
    description: 'Add a work item. `ref` names it for the rest of this batch.',
  }),
  patchWorkItem: defineCommand('patchWorkItem', {
    schema: type({ kind: "'patchWorkItem'", ...target, patch: workItemPatch }),
    scope: 'project',
    description: 'Change fields of a work item; only the fields named change.',
  }),
  moveWorkItem: defineCommand('moveWorkItem', {
    schema: type({ kind: "'moveWorkItem'", ...target, ...placement }),
    scope: 'project',
    description: 'Move a work item under a parent, after a sibling.',
  }),
  duplicateWorkItem: defineCommand('duplicateWorkItem', {
    schema: type({ kind: "'duplicateWorkItem'", ...target, ...reference }),
    scope: 'project',
    description: 'Copy a work item with its whole subtree, placed right after it.',
  }),
  deleteWorkItem: defineCommand('deleteWorkItem', {
    schema: type({ kind: "'deleteWorkItem'", ...target, 'strategy?': "'cascade' | 'promote'" }),
    scope: 'project',
    description:
      'Remove a work item. A parent needs a strategy: cascade its children or promote them.',
  }),
  setEstimate: defineCommand('setEstimate', {
    schema: type({
      kind: "'setEstimate'",
      ...step,
      days: { optimistic: 'number', realistic: 'number', pessimistic: 'number' },
    }),
    scope: 'project',
    description: 'Set the three-point estimate of one step on a leaf work item.',
  }),
  clearEstimate: defineCommand('clearEstimate', {
    schema: type({ kind: "'clearEstimate'", ...step }),
    scope: 'project',
    description: 'Remove one step’s estimate from a work item.',
  }),
  setActual: defineCommand('setActual', {
    schema: type({ kind: "'setActual'", ...step, days: 'number' }),
    scope: 'project',
    description: 'Record the days one step actually took on a work item.',
  }),
  clearActual: defineCommand('clearActual', {
    schema: type({ kind: "'clearActual'", ...step }),
    scope: 'project',
    description: 'Remove one step’s actual from a work item.',
  }),
  setProgress: defineCommand('setProgress', {
    schema: type({ kind: "'setProgress'", ...step, state: "'in_progress' | 'done'" }),
    scope: 'project',
    description: 'Mark one step of a work item in progress or done.',
  }),
  clearProgress: defineCommand('clearProgress', {
    schema: type({ kind: "'clearProgress'", ...step }),
    scope: 'project',
    description: 'Take a step back to not started.',
  }),
  setStatus: defineCommand('setStatus', {
    schema: type({
      kind: "'setStatus'",
      ...target,
      status: "'unknown' | 'done'",
      'on?': 'string',
      'factStart?': 'string',
    }),
    scope: 'project',
    description:
      'Mark a work item done, or take every progress statement back to unknown. `on` is the day it finished (YYYY-MM-DD); absent means today. `factStart` is the day it began, filled where the row holds none. Unknown clears both facts of a row that read done.',
  }),
  setMeasure: defineCommand('setMeasure', {
    schema: type({ kind: "'setMeasure'", ...step, metric: 'string', value: 'number' }),
    scope: 'project',
    description: 'Record a measured figure (tokens, hours…) for one step of a work item.',
  }),
  clearMeasure: defineCommand('clearMeasure', {
    schema: type({ kind: "'clearMeasure'", ...step, metric: 'string' }),
    scope: 'project',
    description: 'Remove one measured figure.',
  }),
  setAssignee: defineCommand('setAssignee', {
    schema: type({
      kind: "'setAssignee'",
      ...step,
      'personId?': 'string | null',
      'personRef?': 'string',
    }),
    scope: 'project',
    description: 'Name who does one step of a work item, or null to unassign.',
  }),
  addDependency: defineCommand('addDependency', {
    schema: type({ kind: "'addDependency'", ...predecessor }),
    scope: 'project',
    description: 'Make a work item wait for another.',
  }),
  removeDependency: defineCommand('removeDependency', {
    schema: type({ kind: "'removeDependency'", ...predecessor }),
    scope: 'project',
    description: 'Stop a work item waiting for another.',
  }),
  arrangeBySchedule: defineCommand('arrangeBySchedule', {
    schema: type({ kind: "'arrangeBySchedule'" }),
    scope: 'project',
    description: 'Put every sibling group in the order its bars start.',
  }),
  freezeProject: defineCommand('freezeProject', {
    schema: type({ kind: "'freezeProject'" }),
    scope: 'project',
    description: 'Freeze every work item number as it stands.',
  }),
  unfreezeProject: defineCommand('unfreezeProject', {
    schema: type({ kind: "'unfreezeProject'" }),
    scope: 'project',
    description: 'Let every number follow the tree again.',
  }),
  unfreezeWorkItem: defineCommand('unfreezeWorkItem', {
    schema: type({ kind: "'unfreezeWorkItem'", ...target }),
    scope: 'project',
    description: 'Let one work item’s number follow the tree again.',
  }),
  setCapacity: defineCommand('setCapacity', {
    schema: type({ kind: "'setCapacity'", ...team, size: 'number | null' }),
    scope: 'project',
    description: 'How many of a team may be at work at once on this project; null means unstated.',
  }),
  setPriorityBands: defineCommand('setPriorityBands', {
    schema: type({
      kind: "'setPriorityBands'",
      bands: type({ startsAt: 'number', defaultValue: 'number', label: 'string' }).array(),
    }),
    scope: 'project',
    description: 'Replace this project’s priority ladder.',
  }),
  createTeam: defineCommand('createTeam', {
    schema: type({ kind: "'createTeam'", ...named }),
    scope: 'directory',
    description: 'Add a team to the directory.',
  }),
  patchTeam: defineCommand('patchTeam', {
    schema: type({
      kind: "'patchTeam'",
      ...team,
      patch: { 'name?': 'string', 'serviceIds?': 'string[]' },
    }),
    scope: 'directory',
    description: 'Rename a team or change the services it owns.',
  }),
  deleteTeam: defineCommand('deleteTeam', {
    schema: type({ kind: "'deleteTeam'", ...team, 'cascade?': 'boolean' }),
    scope: 'directory',
    description: 'Remove a team from the directory.',
  }),
  createPerson: defineCommand('createPerson', {
    schema: type({
      kind: "'createPerson'",
      ...named,
      'teamIds?': 'string[]',
      'teamRefs?': 'string[]',
    }),
    scope: 'directory',
    description: 'Add a person to the directory.',
  }),
  patchPerson: defineCommand('patchPerson', {
    schema: type({
      kind: "'patchPerson'",
      ...person,
      patch: { 'name?': 'string', 'teamIds?': 'string[]', 'kind?': 'string' },
    }),
    scope: 'directory',
    description: 'Rename a person, change their teams or their kind.',
  }),
  deletePerson: defineCommand('deletePerson', {
    schema: type({ kind: "'deletePerson'", ...person, 'cascade?': 'boolean' }),
    scope: 'directory',
    description: 'Remove a person from the directory.',
  }),
  createTag: defineCommand('createTag', {
    schema: type({ kind: "'createTag'", ...named }),
    scope: 'directory',
    description: 'Add a tag to the directory.',
  }),
  patchTag: defineCommand('patchTag', {
    schema: type({ kind: "'patchTag'", ...tag, name: 'string' }),
    scope: 'directory',
    description: 'Rename a tag.',
  }),
  deleteTag: defineCommand('deleteTag', {
    schema: type({ kind: "'deleteTag'", ...tag, 'cascade?': 'boolean' }),
    scope: 'directory',
    description: 'Remove a tag from the directory.',
  }),
  createService: defineCommand('createService', {
    schema: type({ kind: "'createService'", ...named }),
    scope: 'directory',
    description: 'Add a service to the directory.',
  }),
  patchService: defineCommand('patchService', {
    schema: type({ kind: "'patchService'", ...service, name: 'string' }),
    scope: 'directory',
    description: 'Rename a service.',
  }),
  deleteService: defineCommand('deleteService', {
    schema: type({ kind: "'deleteService'", ...service, 'cascade?': 'boolean' }),
    scope: 'directory',
    description: 'Remove a service from the directory.',
  }),
  createWorkItemType: defineCommand('createWorkItemType', {
    schema: type({ kind: "'createWorkItemType'", ...named }),
    scope: 'directory',
    description: 'Add a work item type to the directory.',
  }),
  patchWorkItemType: defineCommand('patchWorkItemType', {
    schema: type({ kind: "'patchWorkItemType'", ...workItemType, name: 'string' }),
    scope: 'directory',
    description: 'Rename a work item type.',
  }),
  deleteWorkItemType: defineCommand('deleteWorkItemType', {
    schema: type({ kind: "'deleteWorkItemType'", ...workItemType, 'cascade?': 'boolean' }),
    scope: 'directory',
    description: 'Remove a work item type from the directory.',
  }),
} as const;

type DefinedCommand = (typeof commandDefinitions)[keyof typeof commandDefinitions];

export type PlanCommandWire = DefinedCommand['schema']['infer'];
export type PlanCommandKind = keyof typeof commandDefinitions;

// Object.keys is bounded by the owned commandDefinitions literal above.
export const PLAN_COMMAND_KINDS = Object.keys(commandDefinitions) as readonly PlanCommandKind[];
