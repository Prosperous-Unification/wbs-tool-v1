import { expect, test } from 'bun:test';

import { loginPassword, readPasswordSession, registerPassword } from './auth-password-shapes';
import { documentFromShapes } from './document-from-shapes';
import { validateSchema } from './schema-shape';

const shapes = [registerPassword, loginPassword, readPasswordSession] as const;

test('declares the three password operations, their media and ordered origin policy', () => {
  expect(shapes.map((shape) => shape.operationId)).toEqual([
    'postApiAuthRegister',
    'postApiAuthLogin',
    'getApiAuthMe',
  ]);
  for (const shape of [registerPassword, loginPassword]) {
    expect(shape.policies).toEqual([{ kind: 'origin', when: 'always' }]);
    expect(shape.bodyMedia).toEqual([
      'application/json',
      'application/x-www-form-urlencoded',
      'multipart/form-data',
    ]);
  }
  expect(readPasswordSession.policies).toEqual([]);

  const document = documentFromShapes(shapes);
  expect(
    Object.keys(document.paths['/api/auth/login']?.['post']?.requestBody?.content ?? {}),
  ).toEqual(['application/json', 'application/x-www-form-urlencoded', 'multipart/form-data']);
});

test('requires exactly string credentials at the request boundary', async () => {
  expect(
    await validateSchema(loginPassword.body, { username: 'ada', password: 'long-pass' }),
  ).toEqual({ value: { username: 'ada', password: 'long-pass' } });
  for (const body of [
    undefined,
    null,
    [],
    {},
    { username: 'ada', password: 1 },
    { username: 'ada', password: 'long-pass', extra: true },
  ]) {
    expect((await validateSchema(loginPassword.body, body)).issues).toBeDefined();
  }
});

test('pins route-specific refusal status and error pairings', () => {
  expect(registerPassword.refusals.map(({ status }) => status)).toEqual([
    400, 403, 404, 409, 422, 429,
  ]);
  expect(loginPassword.refusals.map(({ status }) => status)).toEqual([
    400, 401, 403, 404, 422, 429,
  ]);
  expect(readPasswordSession.refusals.map(({ status }) => status)).toEqual([400, 401]);
});

test('declares an explicit anonymous session while rejecting malformed success bodies', async () => {
  const success = readPasswordSession.responses[0].schema;
  expect(await validateSchema(success, { user: null })).toEqual({ value: { user: null } });
  expect(
    (await validateSchema(success, { user: { id: 'account', username: 'ada' } })).issues,
  ).toBeDefined();
});
