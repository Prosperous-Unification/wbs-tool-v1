import { type } from 'arktype';

import { requestSchema } from './schema-shape';

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
const predecessor = { ...target, 'predecessorId?': 'string', 'predecessorRef?': 'string' } as const;
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

/**
 * Structural wire commands, before the backend parser supplies defaults or checks
 * dates, numeric bounds, names and references. Directory batches intentionally
 * accept this same union so project_required retains the original command index.
 */
// Proof: the generated MCP consumer observed 35 rather than 36 arms after clearMeasure removal, and description length 0 rather than >10 after emptying createWorkItem prose.
// Proof: removing clearMeasure failed both 36-arm validation and emitted branch count; widening actual days admitted a string.
const command = type({
  kind: "'createWorkItem'",
  ...reference,
  ...placement,
  'name?': 'string',
  'notes?': 'string',
  'priority?': 'number | null',
})
  .describe('Add a work item. `ref` names it for the rest of this batch.')
  .or(
    type({ kind: "'patchWorkItem'", ...target, patch: workItemPatch }).describe(
      'Change fields of a work item; only the fields named change.',
    ),
  )
  .or(
    type({ kind: "'moveWorkItem'", ...target, ...placement }).describe(
      'Move a work item under a parent, after a sibling.',
    ),
  )
  .or(
    type({ kind: "'duplicateWorkItem'", ...target, ...reference }).describe(
      'Copy a work item with its whole subtree, placed right after it.',
    ),
  )
  .or(
    type({ kind: "'deleteWorkItem'", ...target, 'strategy?': "'cascade' | 'promote'" }).describe(
      'Remove a work item. A parent needs a strategy: cascade its children or promote them.',
    ),
  )
  .or(
    type({
      kind: "'setEstimate'",
      ...step,
      days: { optimistic: 'number', realistic: 'number', pessimistic: 'number' },
    }).describe('Set the three-point estimate of one step on a leaf work item.'),
  )
  .or(
    type({ kind: "'clearEstimate'", ...step }).describe(
      'Remove one step’s estimate from a work item.',
    ),
  )
  .or(
    type({ kind: "'setActual'", ...step, days: 'number' }).describe(
      'Record the days one step actually took on a work item.',
    ),
  )
  .or(
    type({ kind: "'clearActual'", ...step }).describe('Remove one step’s actual from a work item.'),
  )
  .or(
    type({ kind: "'setProgress'", ...step, state: "'in_progress' | 'done'" }).describe(
      'Mark one step of a work item in progress or done.',
    ),
  )
  .or(type({ kind: "'clearProgress'", ...step }).describe('Take a step back to not started.'))
  .or(
    type({ kind: "'setMeasure'", ...step, metric: 'string', value: 'number' }).describe(
      'Record a measured figure (tokens, hours…) for one step of a work item.',
    ),
  )
  .or(
    type({ kind: "'clearMeasure'", ...step, metric: 'string' }).describe(
      'Remove one measured figure.',
    ),
  )
  .or(
    type({
      kind: "'setAssignee'",
      ...step,
      'personId?': 'string | null',
      'personRef?': 'string',
    }).describe('Name who does one step of a work item, or null to unassign.'),
  )
  .or(
    type({ kind: "'addDependency'", ...predecessor }).describe(
      'Make a work item wait for another.',
    ),
  )
  .or(
    type({ kind: "'removeDependency'", ...predecessor }).describe(
      'Stop a work item waiting for another.',
    ),
  )
  .or(type({ kind: "'freezeProject'" }).describe('Freeze every work item number as it stands.'))
  .or(type({ kind: "'unfreezeProject'" }).describe('Let every number follow the tree again.'))
  .or(
    type({ kind: "'unfreezeWorkItem'", ...target }).describe(
      'Let one work item’s number follow the tree again.',
    ),
  )
  .or(
    type({ kind: "'setCapacity'", ...team, size: 'number | null' }).describe(
      'How many of a team may be at work at once on this project; null means unstated.',
    ),
  )
  .or(
    type({
      kind: "'setPriorityBands'",
      bands: type({ startsAt: 'number', defaultValue: 'number', label: 'string' }).array(),
    }).describe('Replace this project’s priority ladder.'),
  )
  .or(type({ kind: "'createTeam'", ...named }).describe('Add a team to the directory.'))
  .or(
    type({
      kind: "'patchTeam'",
      ...team,
      patch: { 'name?': 'string', 'serviceIds?': 'string[]' },
    }).describe('Rename a team or change the services it owns.'),
  )
  .or(
    type({ kind: "'deleteTeam'", ...team, 'cascade?': 'boolean' }).describe(
      'Remove a team from the directory.',
    ),
  )
  .or(
    type({
      kind: "'createPerson'",
      ...named,
      'teamIds?': 'string[]',
      'teamRefs?': 'string[]',
    }).describe('Add a person to the directory.'),
  )
  .or(
    type({
      kind: "'patchPerson'",
      ...person,
      patch: { 'name?': 'string', 'teamIds?': 'string[]', 'kind?': 'string' },
    }).describe('Rename a person, change their teams or their kind.'),
  )
  .or(
    type({ kind: "'deletePerson'", ...person, 'cascade?': 'boolean' }).describe(
      'Remove a person from the directory.',
    ),
  )
  .or(type({ kind: "'createTag'", ...named }).describe('Add a tag to the directory.'))
  .or(type({ kind: "'patchTag'", ...tag, name: 'string' }).describe('Rename a tag.'))
  .or(
    type({ kind: "'deleteTag'", ...tag, 'cascade?': 'boolean' }).describe(
      'Remove a tag from the directory.',
    ),
  )
  .or(type({ kind: "'createService'", ...named }).describe('Add a service to the directory.'))
  .or(type({ kind: "'patchService'", ...service, name: 'string' }).describe('Rename a service.'))
  .or(
    type({ kind: "'deleteService'", ...service, 'cascade?': 'boolean' }).describe(
      'Remove a service from the directory.',
    ),
  )
  .or(
    type({ kind: "'createWorkItemType'", ...named }).describe(
      'Add a work item type to the directory.',
    ),
  )
  .or(
    type({ kind: "'patchWorkItemType'", ...workItemType, name: 'string' }).describe(
      'Rename a work item type.',
    ),
  )
  .or(
    type({ kind: "'deleteWorkItemType'", ...workItemType, 'cascade?': 'boolean' }).describe(
      'Remove a work item type from the directory.',
    ),
  );

/** Strict standalone command validation; derived numbering is never a writable property. */
export const planCommandSchema = requestSchema(command);

/** The batch cap belongs after semantic parsing; this declaration neither caps nor normalizes commands. */
// Proof: adding maxLength200 failed the 201-command structural control; the parser owns precedence.
const commandsBody = type({ commands: command.array() });
// Proof: bypassing deep strict validation lost invalid_body in the mounted structural-extra case.
export const planCommandsBody = requestSchema(commandsBody);

/** A command exactly as it appeared on the wire, including optional fields absent before normalization. */
// Proof: widening the kind vocabulary or estimate numeric field produced TS2578 in the actual inferred-type fixtures.
export type PlanCommandWire = typeof command.infer;
// Proof: replacing the derived batch with commands:unknown[] made its type-negative fixture report TS2578.
export type PlanCommandsBody = typeof commandsBody.infer;
