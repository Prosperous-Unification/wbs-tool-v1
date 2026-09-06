import { describe, expect, it, spyOn } from 'bun:test';

import { SmokeService } from '../service/smoke.service';
import { testApp } from '../testing/app-fixture';
import { smokeRoutes } from './smoke.routes';

function echoRequest(body: string, suffix = '', headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost/api/smoke/echo${suffix}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

describe('POST /api/smoke/echo', () => {
  it('returns the validated message', async () => {
    const response = await testApp().handle(echoRequest(JSON.stringify({ text: 'hi' })));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ echoed: 'hi' });
  });

  it.each([{ wrong: true }, { text: 42 }, { text: null }])(
    'rejects invalid body with the stable 400 envelope: %j',
    async (body) => {
      const response = await testApp().handle(echoRequest(JSON.stringify(body)));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_body' });
    },
  );

  it('refuses undeclared smoke input instead of silently stripping it', async () => {
    const response = await testApp().handle(
      echoRequest(JSON.stringify({ text: 'hello', extra: { ignored: true } })),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_body' });
  });

  it('names malformed JSON independently from an invalid body', async () => {
    const response = await testApp().handle(echoRequest('{broken'));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_json' });
  });

  it('refuses undeclared query fields', async () => {
    const response = await testApp().handle(
      echoRequest(JSON.stringify({ text: 'hello' }), '?extra=yes'),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_query' });
  });

  it('keeps cookie origin refusal ahead of malformed JSON', async () => {
    const response = await testApp().handle(
      echoRequest('{broken', '', {
        cookie: '__Host-wbs_access=session',
        origin: 'https://foreign.example',
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'invalid_origin' });
  });

  it('executes the endpoint from an explicit typed request without an HTTP adapter', async () => {
    const reply = await smokeRoutes()[0].handle({
      params: {},
      query: undefined,
      body: { text: 'direct' },
      request: {
        url: new URL('http://localhost/api/smoke/echo'),
        method: 'POST',
        headers: new Headers(),
      },
    });
    expect(reply).toEqual({ ok: true, status: 200, body: { echoed: 'direct' } });
  });
});

it('refuses an invalid service representation at the actual smoke response boundary', async () => {
  const echo = spyOn(SmokeService.prototype, 'echo').mockReturnValue(42 as unknown as string);
  try {
    const response = await testApp().handle(echoRequest(JSON.stringify({ text: 'hello' })));
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('Internal Server Error');
  } finally {
    echo.mockRestore();
  }
});
