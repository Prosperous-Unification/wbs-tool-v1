import { commandDefinitions, defineCommand } from '@wbs/contracts';
import { type } from 'arktype';
import { expect, test } from 'bun:test';

import { type CommandNormalizerRecord, commandNormalizers } from './command-normalizers';

export function normalizerTypeCases() {
  const _definitionsWithTemporary = {
    ...commandDefinitions,
    temporaryCommand: defineCommand('temporaryCommand', {
      schema: type({ kind: "'temporaryCommand'" }),
      scope: 'project',
      description: 'Temporary compile-negative command.',
    }),
  } as const;

  // Proof: removing this expected error failed typecheck with TS2741 because
  // `temporaryCommand` was missing from this normalizer record.
  // @ts-expect-error A structural definition without a normalizer makes the record incomplete.
  const incompleteNormalizers: CommandNormalizerRecord<typeof _definitionsWithTemporary> =
    commandNormalizers;

  // Proof: leaving setActual's input as Record<string, unknown> failed core:typecheck here with
  // TS2578 because a clearActual discriminator still satisfied the call.
  // @ts-expect-error A normalizer accepts only the structural command with its own kind.
  commandNormalizers.setActual({ kind: 'clearActual', stepId: 'build', days: 1 });

  const _definitionsWithRenamedStep = {
    ...commandDefinitions,
    setActual: defineCommand('setActual', {
      schema: type({ kind: "'setActual'", stepName: 'string', days: 'number' }),
      scope: 'project',
      description: 'Temporary compile-negative structural field rename.',
    }),
  } as const;

  // Proof: leaving every normalizer input as Record<string, unknown> failed core:typecheck here
  // with TS2578 because replacing required stepId with stepName did not invalidate the record.
  // @ts-expect-error A structural field rename requires its semantic normalizer to change too.
  const staleNormalizers: CommandNormalizerRecord<typeof _definitionsWithRenamedStep> =
    commandNormalizers;
  return { incompleteNormalizers, staleNormalizers };
}

test('preserves priority absence null and number', () => {
  expect(commandNormalizers.createWorkItem({ kind: 'createWorkItem' })).toEqual({
    kind: 'createWorkItem',
    parentId: null,
    afterId: null,
  });
  expect(commandNormalizers.createWorkItem({ kind: 'createWorkItem', priority: null })).toEqual({
    kind: 'createWorkItem',
    parentId: null,
    afterId: null,
    priority: null,
  });
  expect(commandNormalizers.createWorkItem({ kind: 'createWorkItem', priority: 47 })).toEqual({
    kind: 'createWorkItem',
    parentId: null,
    afterId: null,
    priority: 47,
  });
});

test('defaults missing assignee to null', () => {
  expect(commandNormalizers.setAssignee({ kind: 'setAssignee', stepId: 'build' })).toEqual({
    kind: 'setAssignee',
    stepId: 'build',
    personId: null,
  });
});
