import { expect, it } from 'bun:test';

import { testHistoryService } from '../testing/history-fixture';
import { historyRoutes } from './history.routes';

it('returns the modeled missing-project refusal from a literal history request', async () => {
  const endpoint = historyRoutes(testHistoryService())[0];
  const reply = await endpoint.handle({
    params: { id: 'missing' },
    query: {},
    body: undefined,
    principal: { id: 'reader', username: 'reader', scopes: ['read'] },
    request: {
      method: 'GET',
      url: new URL('http://localhost/api/projects/missing/history'),
      headers: new Headers(),
    },
  });
  expect(reply).toEqual({ ok: false, status: 404, body: { error: 'not_found' } });
});
