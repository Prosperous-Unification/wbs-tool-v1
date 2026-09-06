import { expect, spyOn, test } from 'bun:test';

import { ProjectService } from '../service/project.service';
import { recordingBroadcaster } from '../testing/broadcast-fixture';
import { inMemoryProjects, projectRow } from '../testing/project-fixture';
import { solutionRoutes } from './solution.routes';

const input = {
  params: { slug: 'linked' },
  query: undefined,
  body: undefined,
  principal: { id: 'reader', username: 'reader', scopes: ['read'] as const },
  request: {
    method: 'GET',
    url: new URL('https://example.com/plans/by-solution/linked'),
    headers: new Headers(),
  },
};

test('direct solution binding reads the exact slug and complete project with ordered steps', async () => {
  const store = inMemoryProjects();
  const project = projectRow({
    id: 'project',
    restricted: true,
    solutionRef: { slug: 'linked', url: 'https://example.com/linked' },
  });
  const steps = [{ id: 'step', projectId: 'project', name: 'Build', position: 10 }];
  await store.create(project, steps, { at: 1, by: 'owner' });
  const [endpoint] = solutionRoutes(
    new ProjectService({ projects: store, broadcast: recordingBroadcaster() }),
  );
  expect(await endpoint.handle(input)).toEqual({ ok: true, status: 200, body: { project, steps } });
  expect(await endpoint.handle({ ...input, params: { slug: 'other' } })).toEqual({
    ok: false,
    status: 404,
    body: { error: 'not_found' },
  });
});

test('direct solution binding preserves unknown project and step store failures', async () => {
  const store = inMemoryProjects();
  await store.create(
    projectRow({ id: 'project', solutionRef: { slug: 'linked', url: 'https://example.com' } }),
    [],
    { at: 1, by: 'owner' },
  );
  const [endpoint] = solutionRoutes(
    new ProjectService({ projects: store, broadcast: recordingBroadcaster() }),
  );
  for (const method of ['findBySolutionSlug', 'stepsOf'] as const) {
    const failure = new Error(`${method} unavailable`);
    const fault = spyOn(store, method).mockRejectedValue(failure);
    try {
      expect(await endpoint.handle(input).catch((cause: unknown) => cause)).toBe(failure);
    } finally {
      fault.mockRestore();
    }
  }
});
