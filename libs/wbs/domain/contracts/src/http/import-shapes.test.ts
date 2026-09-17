import { expect, test } from 'bun:test';

import type { ClientReply } from './client-types';
import { documentFromShapes } from './document-from-shapes';
import { importProject } from './import-shapes';
import { validateSchema } from './schema-shape';

type ImportSummary = Extract<ClientReply<typeof importProject>, { kind: 'success' }>['body'];

/** Compile-only fixtures exercise the generated import response at its client boundary. */
export function importSummaryTypeFixtures(): void {
  const _incompleteCreatedSummary: ImportSummary = {
    projectId: 'project-1',
    rows: 3,
    // Proof: making createdNames.externalSystems optional produced TS2578 here.
    // @ts-expect-error Created summaries name every directory kind, including external systems.
    created: { teams: [], people: [], tags: [], services: [], types: [] },
    solutionRef: 'none',
  };
}

test('declares the plan import shape and complete typed outcomes', async () => {
  expect(importProject).toMatchObject({
    method: 'POST',
    path: '/api/projects/import',
    operationId: 'postApiProjectsImport',
    policies: [
      { kind: 'origin', when: 'always-unsafe-with-session-cookie' },
      { kind: 'identity', require: 'write-scope' },
    ],
    bodyMedia: ['application/json'],
  });
  expect(importProject.responses.map(({ status }) => status)).toEqual([201]);
  expect(importProject.refusals.map(({ status }) => status)).toEqual([400, 401, 403, 409]);

  const operation = documentFromShapes([importProject]).paths['/api/projects/import']?.['post'];
  expect(operation?.operationId).toBe('postApiProjectsImport');
  expect(Object.keys(operation?.responses ?? {}).sort()).toEqual([
    '201',
    '400',
    '401',
    '403',
    '409',
  ]);
  const malformedSchema = operation?.responses['400']?.content?.['application/json']?.schema;
  expect(malformedSchema).toMatchObject({ type: 'object' });
  if (
    malformedSchema === undefined ||
    typeof malformedSchema !== 'object' ||
    !('required' in malformedSchema)
  )
    throw new Error('import refusal schema is not an object');
  expect(malformedSchema.required?.toSorted()).toEqual(['detail', 'error', 'path']);

  const summary = {
    projectId: 'project-1',
    rows: 3,
    created: {
      teams: ['Billing'],
      people: [],
      tags: [],
      services: [],
      types: [],
      externalSystems: [],
    },
    solutionRef: 'kept' as const,
  };
  expect(await validateSchema(importProject.responses[0].schema, summary)).toEqual({
    value: summary,
  });
  expect(
    (await validateSchema(importProject.responses[0].schema, { ...summary, rows: undefined }))
      .issues,
  ).toBeDefined();
});
