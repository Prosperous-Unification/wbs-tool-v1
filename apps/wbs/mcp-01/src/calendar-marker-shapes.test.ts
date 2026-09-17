import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createCalendarMarker,
  defineEndpointShape,
  documentFromShapes,
  listCalendarMarkers,
  removeCalendarMarker,
  updateCalendarMarker,
} from '@wbs/contracts';
import { expect, test } from 'bun:test';

import { readDocument, toolsFromDocument } from './openapi-tools';

test('derives all marker tools with project id and markerId in separate locations', () => {
  const excluded = [
    '/api/auth/login',
    '/internal/forward',
    '/health',
    '/metrics',
    '/api/smoke/echo',
  ] as const;
  const document = documentFromShapes([
    listCalendarMarkers,
    createCalendarMarker,
    updateCalendarMarker,
    removeCalendarMarker,
    ...excluded.map((path, index) =>
      defineEndpointShape({
        method: 'GET',
        path,
        operationId: `excluded${String(index)}`,
        policies: [],
        responses: [{ kind: 'empty', status: 204 }],
        refusals: [],
        document: { summary: 'Excluded operation' },
      }),
    ),
  ]);
  const directory = mkdtempSync(join(tmpdir(), 'wbs-marker-document-'));
  const file = join(directory, 'openapi.json');
  const tools = (() => {
    try {
      writeFileSync(file, JSON.stringify(document));
      return toolsFromDocument(readDocument(file));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  })();
  expect(tools).toHaveLength(4);
  const create = tools.find((tool) => tool.name === 'postApiProjectsByIdCalendar-markers');
  expect(create?.locations).toEqual({
    id: 'path',
    markerId: 'body',
    date: 'body',
    name: 'body',
    color: 'body',
  });
  expect(create?.inputSchema.required).toEqual(['id', 'date', 'name']);
  const patch = tools.find(
    (tool) => tool.name === 'patchApiProjectsByIdCalendar-markersByMarkerId',
  );
  expect(patch?.locations).toEqual({ id: 'path', markerId: 'path', name: 'body', color: 'body' });
});
