import { expect, test } from 'bun:test';

import {
  listExternalSystems,
  listPeople,
  listServices,
  listTags,
  listTeams,
  listWorkItemTypes,
} from './directory-shapes';
import { documentFromShapes } from './document-from-shapes';
import { validateSchema } from './schema-shape';

const shapes = [
  listTeams,
  listPeople,
  listTags,
  listServices,
  listWorkItemTypes,
  listExternalSystems,
] as const;

test('publishes all six existing directory operation names and complete row fields', () => {
  const document = documentFromShapes(shapes);
  expect(
    Object.entries(document.paths).map(([path, methods]) => [path, methods?.['get']?.operationId]),
  ).toEqual([
    ['/api/teams', 'getApiTeams'],
    ['/api/people', 'getApiPeople'],
    ['/api/tags', 'getApiTags'],
    ['/api/services', 'getApiServices'],
    ['/api/work-item-types', 'getApiWork-item-types'],
    ['/api/external-systems', 'getApiExternal-systems'],
  ]);
  expect(
    document.paths['/api/teams']?.['get']?.responses['200']?.content?.['application/json']?.schema,
  ).toMatchObject({ properties: { teams: { items: { required: ['id', 'name', 'serviceIds'] } } } });
  expect(
    document.paths['/api/people']?.['get']?.responses['200']?.content?.['application/json']?.schema,
  ).toMatchObject({
    properties: { people: { items: { required: ['id', 'kind', 'name', 'teamIds'] } } },
  });
});

test('validates required memberships and person kind while retaining additive audit fields', async () => {
  const team = listTeams.responses[0].schema;
  const people = listPeople.responses[0].schema;
  expect((await validateSchema(team, { teams: [{ id: 't', name: 'Team' }] })).issues).toBeDefined();
  expect(
    (await validateSchema(team, { teams: [{ id: 't', name: 'Team', serviceIds: [4] }] })).issues,
  ).toBeDefined();
  for (const person of [
    { id: 'p', name: 'Person', teamIds: [] },
    { id: 'p', name: 'Person', kind: 'robot', teamIds: [] },
    { id: 'p', name: 'Person', kind: 'person' },
    { id: 'p', name: 'Person', kind: 'agent', teamIds: [4] },
  ])
    expect((await validateSchema(people, { people: [person] })).issues).toBeDefined();
  const enriched = {
    people: [
      {
        id: 'p',
        name: 'Person',
        kind: 'agent' as const,
        teamIds: ['t'],
        createdAt: 42,
        createdBy: 'owner',
      },
    ],
  };
  expect(await validateSchema(people, enriched)).toEqual({ value: enriched });
});
