import { describe, expect, spyOn, test } from 'bun:test';

import { testApp } from '../testing/app-fixture';
import { testAuthService } from '../testing/auth-fixture';

const origin = 'https://app.example';

describe('trusted origin without OIDC configuration', () => {
  for (const action of ['login', 'register'] as const) {
    test(`${action} requires the configured origin before parsing or invoking authentication`, async () => {
      const auth = testAuthService();
      const attempts = spyOn(auth, action);
      const app = testApp({ appOrigin: origin, auth });
      const refusedHeaders: Record<string, string>[] = [{}, { origin: 'https://foreign.example' }];
      for (const headers of refusedHeaders) {
        const response = await app.handle(
          new Request(`https://backend.example/api/auth/${action}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...headers },
            body: '{',
          }),
        );
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: 'invalid_origin' });
      }
      expect(attempts).not.toHaveBeenCalled();
      const allowed = await app.handle(
        new Request(`https://backend.example/api/auth/${action}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin },
          body: JSON.stringify({ username: 'origin-reader', password: 'valid-password-123' }),
        }),
      );
      expect(allowed.status).toBe(action === 'login' ? 401 : 200);
      expect(attempts).toHaveBeenCalledTimes(1);
      attempts.mockRestore();
    });
  }
  test('refuses unsafe session-cookie requests even without OIDC configuration', async () => {
    const app = testApp({ appOrigin: origin });
    const response = await app.handle(
      new Request('https://backend.example/api/smoke/echo', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: '__Host-wbs_access=token',
          origin: 'https://foreign.example',
        },
        body: JSON.stringify({ text: 'forbidden' }),
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'invalid_origin' });
  });
});

for (const action of ['login', 'register'] as const) {
  test(`protects the router's trailing-slash ${action} alias before authentication`, async () => {
    const auth = testAuthService();
    const attempts = spyOn(auth, action);
    const app = testApp({ appOrigin: origin, auth });
    const refusedHeaders: Record<string, string>[] = [{}, { origin: 'https://foreign.example' }];
    for (const headers of refusedHeaders) {
      const response = await app.handle(
        new Request(`https://backend.example/api/auth/${action}/`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify({ username: 'alias-reader', password: 'valid-password-123' }),
        }),
      );
      expect(attempts).not.toHaveBeenCalled();
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'invalid_origin' });
    }
    attempts.mockRestore();
  });
}
