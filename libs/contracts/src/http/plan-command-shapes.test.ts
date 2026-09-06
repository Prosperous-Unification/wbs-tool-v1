import { expect, test } from 'bun:test';

import {
  type PlanCommandsBody,
  planCommandsBody,
  planCommandSchema,
  type PlanCommandWire,
} from './plan-command-shapes';
import { validateSchema } from './schema-shape';

const commands: PlanCommandWire[] = [
  { kind: 'createWorkItem' },
  { kind: 'patchWorkItem', patch: {} },
  { kind: 'moveWorkItem' },
  { kind: 'duplicateWorkItem' },
  { kind: 'deleteWorkItem' },
  { kind: 'setEstimate', stepId: 's', days: { optimistic: 1, realistic: 2, pessimistic: 3 } },
  { kind: 'clearEstimate', stepId: 's' },
  { kind: 'setActual', stepId: 's', days: -1 },
  { kind: 'clearActual', stepId: 's' },
  { kind: 'setProgress', stepId: 's', state: 'done' },
  { kind: 'clearProgress', stepId: 's' },
  { kind: 'setMeasure', stepId: 's', metric: 'future', value: -1 },
  { kind: 'clearMeasure', stepId: 's', metric: 'future' },
  { kind: 'setAssignee', stepId: 's' },
  { kind: 'addDependency' },
  { kind: 'removeDependency' },
  { kind: 'freezeProject' },
  { kind: 'unfreezeProject' },
  { kind: 'unfreezeWorkItem' },
  { kind: 'setCapacity', size: null },
  { kind: 'setPriorityBands', bands: [{ startsAt: -1, defaultValue: 2, label: ' ' }] },
  { kind: 'createTeam', name: ' ' },
  { kind: 'patchTeam', patch: {} },
  { kind: 'deleteTeam' },
  { kind: 'createPerson', name: ' ' },
  { kind: 'patchPerson', patch: { kind: 'future' } },
  { kind: 'deletePerson' },
  { kind: 'createTag', name: 'x' },
  { kind: 'patchTag', name: 'x' },
  { kind: 'deleteTag' },
  { kind: 'createService', name: 'x' },
  { kind: 'patchService', name: 'x' },
  { kind: 'deleteService' },
  { kind: 'createWorkItemType', name: 'x' },
  { kind: 'patchWorkItemType', name: 'x' },
  { kind: 'deleteWorkItemType' },
];

test('validates all 36 structural wire arms without applying semantic defaults or a batch cap', async () => {
  expect(commands).toHaveLength(36);
  for (const command of commands) {
    expect(await validateSchema(planCommandSchema, command)).toEqual({ value: command });
  }
  const batch = {
    commands: Array.from({ length: 201 }, () => ({ kind: 'freezeProject' as const })),
  };
  expect(await validateSchema(planCommandsBody, batch)).toEqual({ value: batch });
  expect(await validateSchema(planCommandsBody, { commands: [] })).toEqual({
    value: { commands: [] },
  });
});

test('preserves optional fields, nulls and unresolved references without normalization', async () => {
  const command: PlanCommandWire = {
    kind: 'patchWorkItem',
    workItemId: '',
    workItemRef: 'unresolved',
    patch: {
      name: ' ',
      notes: ' ',
      startNoEarlierThan: 'not-a-date',
      startNoEarlierThanReason: ' ',
      priority: null,
      serviceTeamId: null,
      maxParallel: -1,
      teamIds: ['x', 'x'],
      tagIds: [],
      serviceIds: [],
      typeIds: [],
      teamRefs: ['new'],
      tagRefs: [],
      serviceRefs: [],
      typeRefs: [],
      externalRefs: [{ systemId: 'unresolved', url: 'not-a-url' }],
    },
  };
  expect(await validateSchema(planCommandSchema, command)).toEqual({ value: command });
  for (const command of [
    {
      kind: 'createWorkItem',
      parentId: null,
      afterId: null,
      priority: null,
      ref: 'new',
      name: '',
      notes: '',
    },
    { kind: 'setAssignee', stepId: 's', personId: null, personRef: 'unresolved' },
    { kind: 'patchTeam', teamRef: 'new', patch: { name: '', serviceIds: ['x'] } },
    { kind: 'createPerson', ref: 'new', name: 'x', teamIds: [], teamRefs: ['new'] },
  ] satisfies PlanCommandWire[])
    expect(await validateSchema(planCommandSchema, command)).toEqual({ value: command });
});

test('rejects malformed structures and nested extras including derived numbering', async () => {
  for (const command of [
    { kind: 'invented' },
    { kind: 'setActual', stepId: 's', days: '1' },
    { kind: 'setProgress', stepId: 's', state: 'not_started' },
    { kind: 'deleteWorkItem', strategy: 'unknown' },
    { kind: 'createWorkItem', number: '001' },
    { kind: 'createWorkItem', frozenNumber: '001' },
    { kind: 'patchWorkItem', patch: { frozenNumber: '001' } },
    { kind: 'patchWorkItem', patch: [] },
    { kind: 'patchWorkItem', patch: { externalRefs: [{ systemId: 'x', url: 'x', extra: 1 }] } },
    { kind: 'patchWorkItem', patch: { extra: 1 } },
    {
      kind: 'setEstimate',
      stepId: 's',
      days: { optimistic: 1, realistic: 2, pessimistic: 3, extra: 1 },
    },
    { kind: 'setPriorityBands', bands: [{ startsAt: 1, defaultValue: 1, label: 'x', extra: 1 }] },
    { kind: 'patchTeam', patch: { extra: 1 } },
    { kind: 'patchPerson', patch: { kind: 42 } },
    { kind: 'deletePerson', cascade: 'true' },
    { kind: 'freezeProject', extra: 1 },
  ])
    expect((await validateSchema(planCommandSchema, command)).issues).toBeDefined();
  for (const body of [{ commands: 'bad' }, { commands: [], extra: 1 }, []])
    expect((await validateSchema(planCommandsBody, body)).issues).toBeDefined();
});

test('emits inline MCP-readable command branches with real nested patch and estimate properties', () => {
  interface Descriptor {
    properties?: Record<string, Descriptor>;
    items?: Descriptor;
    anyOf?: Descriptor[];
    const?: string;
    required?: string[];
    type?: string;
  }
  const descriptor = planCommandsBody.jsonSchema as Descriptor;
  expect(JSON.stringify(descriptor)).not.toContain('"$ref"');
  const branches = descriptor.properties?.['commands']?.items?.anyOf;
  expect(branches).toHaveLength(36);
  if (branches === undefined) throw new Error('Missing command alternatives');
  const find = (kind: string) =>
    branches.find((branch) => branch.properties?.['kind']?.const === kind);
  expect(
    find('patchWorkItem')?.properties?.['patch']?.properties?.['externalRefs']?.items?.properties,
  ).toEqual({ systemId: { type: 'string' }, url: { type: 'string' } });
  expect(find('setEstimate')?.properties?.['days']?.required).toEqual([
    'optimistic',
    'pessimistic',
    'realistic',
  ]);
  expect(find('setAssignee')?.required).not.toContain('personId');
  expect(find('deleteService')?.properties?.['cascade']).toEqual({ type: 'boolean' });
});

function commandTypes(command: PlanCommandWire) {
  if (command.kind === 'setAssignee') {
    const id: string | null | undefined = command.personId;
    void id;
  }
  if (command.kind === 'patchWorkItem') {
    const refs: { systemId: string; url: string }[] | undefined = command.patch.externalRefs;
    void refs;
    // @ts-expect-error Numbering is derived and never part of a writable patch.
    void command.patch.frozenNumber;
  }
  // @ts-expect-error Commands retain their finite discriminated vocabulary.
  const invented: PlanCommandWire = { kind: 'invented' };
  void invented;
  const wrongEstimate = {
    kind: 'setEstimate' as const,
    stepId: 's',
    days: { optimistic: '1', realistic: 2, pessimistic: 3 },
  };
  // @ts-expect-error Estimate days retain the three numeric fields.
  const estimate: PlanCommandWire = wrongEstimate;
  void estimate;
  // @ts-expect-error The inferred batch keeps the command vocabulary rather than an unknown list.
  const batch: PlanCommandsBody = { commands: [{ kind: 'invented' }] };
  void batch;
}
void commandTypes;

test('retains the nullable deadline wire field without taking over date semantics', async () => {
  for (const deadline of [null, '2026-09-07', 'not-a-date']) {
    const command = { kind: 'patchWorkItem', patch: { deadline } } as const;
    expect(await validateSchema(planCommandSchema, command)).toEqual({ value: command });
  }
});
