import { createCalendarMarker, removeCalendarMarker, updateCalendarMarker } from '@wbs/contracts';
import { expect, test } from 'bun:test';
import { Elysia } from 'elysia';

import { bunPasswordHasher, joseTokenCodec } from '../../runtime/bun-runtime';
import { AuthService } from '../../service/auth.service';
import { inMemoryUsers, TEST_JWT_KEY } from '../../testing/auth-fixture';
import { testClock } from '../../testing/clock-fixture';
import { bind } from '../endpoint';
import { identityResolver } from '../identity';
import { mountEndpoints } from './mount';

test('marker refusal bindings reject malformed known fields while preserving bare and marker details', async () => {
  const auth = new AuthService({
    clock: testClock,
    users: inMemoryUsers(),
    tokens: joseTokenCodec(TEST_JWT_KEY),
    passwords: bunPasswordHasher,
    localIdentity: { id: 'owner', username: 'owner', scopes: ['read', 'write'] },
  });
  for (const shape of [createCalendarMarker, updateCalendarMarker, removeCalendarMarker]) {
    for (const [status, error] of [
      [404, 'not_found'],
      [409, 'taken'],
    ] as const) {
      for (const detail of [{}, { field: 'markerId' }, { field: 'name' }, { field: 7 }]) {
        const body = { error, ...detail, future: true };
        // Corrupt the trusted handler reply to exercise production response validation.
        const endpoint = bind(shape, () => Promise.resolve({ ok: false, status, body } as never));
        const app = new Elysia().use(
          mountEndpoints([endpoint], {
            appOrigin: 'https://app.example',
            resolveIdentity: identityResolver(auth, 'internal-test-secret'),
          }),
        );
        const response = await app.handle(
          new Request(
            `https://backend.example${shape.path.replace(':id', 'project').replace(':markerId', 'marker')}`,
            {
              method: shape.method,
              headers: { 'content-type': 'application/json' },
              ...(shape.method === 'DELETE'
                ? {}
                : {
                    body: JSON.stringify(
                      shape.method === 'POST'
                        ? { date: '2026-09-01', name: 'Name' }
                        : { name: 'Name' },
                    ),
                  }),
            },
          ),
        );
        const valid = !('field' in detail) || detail.field === 'markerId';
        expect(response.status).toBe(valid ? status : 500);
        if (valid) expect(await response.json()).toEqual(body);
      }
    }
  }
});
