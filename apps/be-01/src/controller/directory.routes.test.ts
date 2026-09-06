import { expect, spyOn, test } from 'bun:test';

import { inMemoryDirectory, testDirectoryService } from '../testing/directory-fixture';
import { directoryRoutes } from './directory.routes';

const input = {
  params: {},
  query: undefined,
  body: undefined,
  principal: { id: 'reader', username: 'reader', scopes: [] },
  request: { method: 'GET', url: new URL('https://app.example/api/teams'), headers: new Headers() },
};

test('direct directory bindings return every service list without inventing a project restriction', async () => {
  const service = testDirectoryService();
  await service.addTeam('owner', 'Team');
  await service.addPerson('owner', 'Person', []);
  await service.addTag('owner', 'Tag');
  await service.addService('owner', 'Service');
  await service.addWorkItemType('owner', 'Type');
  const [teams, people, tags, services, types, systems] = directoryRoutes(service);
  expect(await teams.handle(input)).toEqual({
    ok: true,
    status: 200,
    body: { teams: await service.listTeams() },
  });
  expect(await people.handle(input)).toEqual({
    ok: true,
    status: 200,
    body: { people: await service.listPeople() },
  });
  expect(await tags.handle(input)).toEqual({
    ok: true,
    status: 200,
    body: { tags: await service.listTags() },
  });
  expect(await services.handle(input)).toEqual({
    ok: true,
    status: 200,
    body: { services: await service.listServices() },
  });
  expect(await types.handle(input)).toEqual({
    ok: true,
    status: 200,
    body: { workItemTypes: await service.listWorkItemTypes() },
  });
  expect(await systems.handle(input)).toEqual({
    ok: true,
    status: 200,
    body: { externalSystems: await service.listExternalSystems() },
  });
});

test('every direct directory binding rejects the original unknown store failure', async () => {
  const store = inMemoryDirectory();
  const service = testDirectoryService(store);
  const failure = new Error('directory unavailable');
  for (const method of [
    'listTeams',
    'listPeople',
    'listTags',
    'listServices',
    'listWorkItemTypes',
    'listExternalSystems',
  ] as const) {
    const fault = spyOn(store, method).mockRejectedValue(failure);
    try {
      const endpoint = directoryRoutes(service).find(
        (entry) =>
          entry.shape.operationId ===
          {
            listTeams: 'getApiTeams',
            listPeople: 'getApiPeople',
            listTags: 'getApiTags',
            listServices: 'getApiServices',
            listWorkItemTypes: 'getApiWork-item-types',
            listExternalSystems: 'getApiExternal-systems',
          }[method],
      );
      if (endpoint === undefined) throw new Error(`Missing directory binding ${method}`);
      const refused = await endpoint.handle(input).catch((cause: unknown) => cause);
      expect(refused).toBe(failure);
    } finally {
      fault.mockRestore();
    }
  }
});
