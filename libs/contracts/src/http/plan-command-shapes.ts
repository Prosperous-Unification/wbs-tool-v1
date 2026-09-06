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
  'externalRefs?': type({ systemId: 'string', url: 'string' }).array(),
});

/**
 * Structural wire commands, before the backend parser supplies defaults or checks
 * dates, numeric bounds, names and references. Directory batches intentionally
 * accept this same union so project_required retains the original command index.
 */
// Proof: removing clearMeasure failed both 36-arm validation and emitted branch count; widening actual days admitted a string.
const command = type({
  kind: "'createWorkItem'",
  ...reference,
  ...placement,
  'name?': 'string',
  'notes?': 'string',
  'priority?': 'number | null',
})
  .or({ kind: "'patchWorkItem'", ...target, patch: workItemPatch })
  .or({ kind: "'moveWorkItem'", ...target, ...placement })
  .or({ kind: "'duplicateWorkItem'", ...target, ...reference })
  .or({ kind: "'deleteWorkItem'", ...target, 'strategy?': "'cascade' | 'promote'" })
  .or({
    kind: "'setEstimate'",
    ...step,
    days: { optimistic: 'number', realistic: 'number', pessimistic: 'number' },
  })
  .or({ kind: "'clearEstimate'", ...step })
  .or({ kind: "'setActual'", ...step, days: 'number' })
  .or({ kind: "'clearActual'", ...step })
  .or({ kind: "'setProgress'", ...step, state: "'in_progress' | 'done'" })
  .or({ kind: "'clearProgress'", ...step })
  .or({ kind: "'setMeasure'", ...step, metric: 'string', value: 'number' })
  .or({ kind: "'clearMeasure'", ...step, metric: 'string' })
  .or({ kind: "'setAssignee'", ...step, 'personId?': 'string | null', 'personRef?': 'string' })
  .or({ kind: "'addDependency'", ...predecessor })
  .or({ kind: "'removeDependency'", ...predecessor })
  .or({ kind: "'freezeProject'" })
  .or({ kind: "'unfreezeProject'" })
  .or({ kind: "'unfreezeWorkItem'", ...target })
  .or({ kind: "'setCapacity'", ...team, size: 'number | null' })
  .or({
    kind: "'setPriorityBands'",
    bands: type({ startsAt: 'number', defaultValue: 'number', label: 'string' }).array(),
  })
  .or({ kind: "'createTeam'", ...named })
  .or({ kind: "'patchTeam'", ...team, patch: { 'name?': 'string', 'serviceIds?': 'string[]' } })
  .or({ kind: "'deleteTeam'", ...team, 'cascade?': 'boolean' })
  .or({ kind: "'createPerson'", ...named, 'teamIds?': 'string[]', 'teamRefs?': 'string[]' })
  .or({
    kind: "'patchPerson'",
    ...person,
    patch: { 'name?': 'string', 'teamIds?': 'string[]', 'kind?': 'string' },
  })
  .or({ kind: "'deletePerson'", ...person, 'cascade?': 'boolean' })
  .or({ kind: "'createTag'", ...named })
  .or({ kind: "'patchTag'", ...tag, name: 'string' })
  .or({ kind: "'deleteTag'", ...tag, 'cascade?': 'boolean' })
  .or({ kind: "'createService'", ...named })
  .or({ kind: "'patchService'", ...service, name: 'string' })
  .or({ kind: "'deleteService'", ...service, 'cascade?': 'boolean' })
  .or({ kind: "'createWorkItemType'", ...named })
  .or({ kind: "'patchWorkItemType'", ...workItemType, name: 'string' })
  .or({ kind: "'deleteWorkItemType'", ...workItemType, 'cascade?': 'boolean' });

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
