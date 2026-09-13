import { documentFromShapes, httpShapes } from '@wbs/contracts';
import { expect, test } from 'bun:test';

import { readDocument, toolsFromDocument } from './openapi-tools';

test('default MCP document is generated directly from the shared declarations', () => {
  expect(readDocument()).toEqual(documentFromShapes(httpShapes));
  const tools = toolsFromDocument(readDocument());
  // Proof: retaining the pre-Retry inventory failed here on `Expected length:
  // 32`, `Received length: 33` before the explicit operation inventory ran.
  expect(tools).toHaveLength(33);
  expect(tools.map((tool) => tool.name)).toContain('postApiProjectsByIdCommands');
  expect(tools.map((tool) => tool.name)).toContain('getApiProjectsByIdSaved-plansCompare');
});

test('required exclusion drift remains a failure when operational routes are absent', () => {
  const document = documentFromShapes(httpShapes);
  for (const path of Object.keys(document.paths))
    if (path.startsWith('/internal/')) Reflect.deleteProperty(document.paths, path);
  expect(() => toolsFromDocument(document)).toThrow('exclusion list');
});

test('pins every generated MCP operation name independently of the registry', () => {
  // Proof: omitting Retry failed with `postApiProjectsByIdOptimizationRetry`
  // as the one received-only operation.
  expect(
    toolsFromDocument(readDocument())
      .map((tool) => tool.name)
      .sort(),
  ).toEqual([
    'deleteApiProjectsByIdCalendar-markersByMarkerId',
    'deleteApiProjectsByIdStepsByStepId',
    'deleteApiSaved-plansById',
    'getApiExternal-systems',
    'getApiPeople',
    'getApiProjects',
    'getApiProjectsById',
    'getApiProjectsByIdCalendar-markers',
    'getApiProjectsByIdExport',
    'getApiProjectsByIdHistory',
    'getApiProjectsByIdSaved-plans',
    'getApiProjectsByIdSaved-plansCompare',
    'getApiProjectsByIdWork-items',
    'getApiSaved-plansById',
    'getApiServices',
    'getApiTags',
    'getApiTeams',
    'getApiWork-item-types',
    'getPlansBy-solutionBySlug',
    'patchApiProjectsById',
    'patchApiProjectsByIdCalendar-markersByMarkerId',
    'patchApiProjectsByIdStepsByStepId',
    'patchApiSaved-plansById',
    'postApiDirectoryCommands',
    'postApiProjects',
    'postApiProjectsByIdCalendar-markers',
    'postApiProjectsByIdCommands',
    'postApiProjectsByIdOpened',
    'postApiProjectsByIdOptimizationRetry',
    'postApiProjectsByIdRedo',
    'postApiProjectsByIdSaved-plans',
    'postApiProjectsByIdSteps',
    'postApiProjectsByIdUndo',
  ]);
});

test('refuses a generated operation whose name was lost before MCP derivation', () => {
  const document = documentFromShapes(httpShapes);
  const operation = document.paths['/api/projects']?.['post'];
  if (operation === undefined) throw new Error('project creation fixture missing');
  Reflect.deleteProperty(operation, 'operationId');
  expect(() => toolsFromDocument(document)).toThrow('no operationId');
});

test('optional operational deny paths cannot become tools in external documents', () => {
  const document = documentFromShapes(httpShapes);
  document.paths['/health'] = {
    get: { operationId: 'getHealth', summary: 'Health', parameters: [], responses: {} },
  };
  document.paths['/metrics'] = {
    get: { operationId: 'getMetrics', summary: 'Metrics', parameters: [], responses: {} },
  };
  expect(toolsFromDocument(document).map((tool) => tool.name)).not.toContain('getHealth');
  expect(toolsFromDocument(document).map((tool) => tool.name)).not.toContain('getMetrics');
});
