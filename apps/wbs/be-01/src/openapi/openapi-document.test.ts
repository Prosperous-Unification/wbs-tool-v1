import { describe, expect, it } from 'bun:test';

import { testApp } from '../testing/app-fixture';
import { documentFromApp, serialiseDocument } from './document-from-app';
import { OPENAPI_SPEC_PATH } from './openapi-plugin';

describe('the generated shared OpenAPI document', () => {
  it('serves the mounted import shape and omits local-inapplicable routes', async () => {
    const document = await documentFromApp(testApp());
    const paths = document['paths'];
    if (!isRecord(paths)) throw new Error('generated document has no paths object');
    // Proof: publishing the full registry in this local-mode app produced 45
    // operations and advertised an OIDC callback whose request returned 404.
    // Omitting importRoutes removed this exact operation from the mounted document.
    expect(paths).toHaveProperty(
      ['/api/projects/import', 'post', 'operationId'],
      'postApiProjectsImport',
    );
    expect(paths).toHaveProperty(
      [
        '/api/projects/import',
        'post',
        'requestBody',
        'content',
        'application/json',
        'schema',
        'type',
      ],
      'object',
    );
    expect(JSON.stringify(paths['/api/projects/import'])).not.toContain('"$ref"');
    expect(paths).not.toHaveProperty('/api/auth/okta/callback');
  });
  it('preserves operation names and omits operational routes until they have bindings', async () => {
    const document = await documentFromApp(testApp());
    expect(document).toHaveProperty('openapi', '3.1.0');
    const paths = document['paths'];
    expect(paths).toHaveProperty(
      ['/api/projects/{id}/commands', 'post', 'operationId'],
      'postApiProjectsByIdCommands',
    );
    expect(paths).toHaveProperty(['/api/auth/login', 'post', 'operationId'], 'postApiAuthLogin');
    expect(paths).toHaveProperty('/health.get.operationId', 'getHealth');
    expect(paths).toHaveProperty('/metrics.get.operationId', 'getMetrics');
  });
  it('does not change descriptors after another app parses requests', async () => {
    const before = serialiseDocument(await documentFromApp(testApp()));
    await testApp().handle(
      new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { origin: 'http://localhost', 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(serialiseDocument(await documentFromApp(testApp()))).toBe(before);
  });
  it('publishes JSON only and leaves the old UI unmounted', async () => {
    const app = testApp();
    const response = await app.handle(new Request(`http://localhost${OPENAPI_SPEC_PATH}`));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect((await app.handle(new Request('http://localhost/openapi'))).status).toBe(404);
  });
  it('refuses a missing document route and malformed document payloads', () => {
    for (const response of [
      new Response(null, { status: 404 }),
      Response.json(null),
      Response.json([]),
    ])
      expect(documentFromApp({ handle: () => Promise.resolve(response) })).rejects.toThrow();
  });
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
