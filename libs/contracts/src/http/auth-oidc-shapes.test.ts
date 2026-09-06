import { expect, test } from 'bun:test';

import {
  completeOidcLogin,
  logoutOidcSession,
  refreshOidcSession,
  startOidcLogin,
} from './auth-oidc-shapes';
import { documentFromShapes } from './document-from-shapes';

test('declares four OIDC operations, open provider queries and empty redirects', () => {
  const shapes = [startOidcLogin, completeOidcLogin, refreshOidcSession, logoutOidcSession];
  expect(shapes.map((shape) => shape.operationId)).toEqual([
    'getApiAuthLogin',
    'getApiAuthOktaCallback',
    'postApiAuthRefresh',
    'postApiAuthLogout',
  ]);
  expect(completeOidcLogin.queryMode).toBe('arbitrary-singleton');
  expect(startOidcLogin.responses).toEqual([{ kind: 'empty', status: 302 }]);
  expect(refreshOidcSession.responses).toEqual([{ kind: 'empty', status: 204 }]);
  expect(
    documentFromShapes(shapes).paths['/api/auth/okta/callback']?.['get']?.parameters,
  ).toMatchObject([{ in: 'query', style: 'form', explode: true }]);
});
