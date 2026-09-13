import { type } from 'arktype';
import { expect, test } from 'bun:test';

import { planCommandsBody } from '../http/plan-command-shapes';
import {
  commandDefinitions,
  defineCommand,
  PLAN_COMMAND_KINDS,
  type PlanCommandKind,
  type PlanCommandWire,
} from './definitions';

const PINNED_COMMAND_KINDS = [
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
  'setStatus',
  'setMeasure',
  'clearMeasure',
  'setAssignee',
  'addDependency',
  'removeDependency',
  'arrangeBySchedule',
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
  'createWorkItemType',
  'patchWorkItemType',
  'deleteWorkItemType',
] as const satisfies readonly PlanCommandWire['kind'][];

interface CommandDescriptor {
  properties?: {
    kind?: { const?: string };
    commands?: { items?: { anyOf?: CommandDescriptor[] } };
  };
}

test('pins every current structural command kind independently of its declaration', () => {
  const descriptor = planCommandsBody.jsonSchema as CommandDescriptor;
  const branches = descriptor.properties?.commands?.items?.anyOf;
  if (branches === undefined) throw new Error('Missing command alternatives');
  const emittedKinds = branches.map((branch) => branch.properties?.kind?.const);

  // Proof: deleting the production clearMeasure arm failed this assertion with the expected
  // set containing "clearMeasure" and the received set omitting it.
  expect(new Set(emittedKinds)).toEqual(new Set(PINNED_COMMAND_KINDS));
  expect(emittedKinds).toHaveLength(PINNED_COMMAND_KINDS.length);
  expect(new Set<string>(PLAN_COMMAND_KINDS)).toEqual(new Set(PINNED_COMMAND_KINDS));
});

test('definition key agrees with its discriminator', () => {
  for (const [kind, definition] of Object.entries(commandDefinitions)) {
    const descriptor = definition.schema.toJsonSchema() as CommandDescriptor;
    // Proof: renaming the production createWorkItem key to createWorkItemWrong failed here with received "createWorkItem".
    expect(descriptor.properties?.kind?.const).toBe(kind);
  }
});

export function definitionTypeCases() {
  // Proof: removing MatchingKind made this compile fixture fail with TS2578.
  // @ts-expect-error A definition key must agree with its schema discriminator.
  defineCommand('setMeasure', {
    schema: type({ kind: "'clearMeasure'", stepId: 'string', metric: 'string' }),
    scope: 'project',
    description: 'Wrongly binds clearMeasure under setMeasure.',
  });
  const kind: PlanCommandKind = 'clearMeasure';
  return kind;
}
