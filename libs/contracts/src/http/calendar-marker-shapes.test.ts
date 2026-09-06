import { expect, test } from 'bun:test';

import {
  createCalendarMarker,
  listCalendarMarkers,
  removeCalendarMarker,
  updateCalendarMarker,
} from './calendar-marker-shapes';
import { documentFromShapes } from './document-from-shapes';
import { validateSchema } from './schema-shape';

test('emits four marker operations with a distinct markerId body argument', () => {
  const document = documentFromShapes([
    listCalendarMarkers,
    createCalendarMarker,
    updateCalendarMarker,
    removeCalendarMarker,
  ]);
  const collection = document.paths['/api/projects/{id}/calendar-markers'];
  const addressed = document.paths['/api/projects/{id}/calendar-markers/{markerId}'];
  expect(collection?.['get']?.operationId).toBe('getApiProjectsByIdCalendar-markers');
  expect(collection?.['post']?.operationId).toBe('postApiProjectsByIdCalendar-markers');
  expect(addressed?.['patch']?.operationId).toBe('patchApiProjectsByIdCalendar-markersByMarkerId');
  expect(addressed?.['delete']?.operationId).toBe(
    'deleteApiProjectsByIdCalendar-markersByMarkerId',
  );
  expect(collection?.['post']?.requestBody?.content['application/json']?.schema).toMatchObject({
    properties: {
      markerId: { type: 'string' },
      date: { type: 'string' },
      name: { type: 'string' },
    },
    required: ['date', 'name'],
    additionalProperties: false,
  });
});

test('PATCH describes optional writable fields and rejects undeclared immutable fields', async () => {
  for (const body of [
    {},
    { name: 'Name', color: null },
    { name: 'Name' },
    { color: null },
    { color: '#5d6afe' },
  ])
    expect((await validateSchema(updateCalendarMarker.body, body)).issues).toBeUndefined();
  for (const body of [
    { name: 'Name', date: '2026-09-01' },
    { color: null, markerId: 'id' },
  ])
    expect((await validateSchema(updateCalendarMarker.body, body)).issues).toBeDefined();
});

test('responses require resolved colors and retain additive marker fields', async () => {
  const marker = {
    id: 'm',
    projectId: 'p',
    date: '2026-09-01',
    name: 'Name',
    color: '#5d6afe',
    createdAt: 1,
    extra: true,
  };
  expect(await validateSchema(createCalendarMarker.responses[0].schema, { marker })).toEqual({
    value: { marker },
  });
  expect(
    (
      await validateSchema(createCalendarMarker.responses[0].schema, {
        marker: { ...marker, color: null },
      })
    ).issues,
  ).toBeDefined();
});
