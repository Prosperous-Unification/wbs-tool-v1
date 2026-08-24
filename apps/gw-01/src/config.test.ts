import { describe, expect, it } from 'bun:test';
import { SignJWT } from 'jose';

import { loadConfig } from './config';

const VALID = {
  AUTH_MODE: 'local',
  BE_URL: 'http://localhost:3100',
  INTERNAL_AUTH_SECRET: 'a'.repeat(32),
  JWT_SIGNING_KEY_CURRENT: 'b'.repeat(32),
  LOG_LEVEL: 'info',
  PORT: '3200',
};

describe('loadConfig', () => {
  it('supplies the fixed identity for cookie-free local WebSockets', () => {
    expect(loadConfig(VALID).wsAuth?.localIdentity).toBe('local-dev');
  });

  it('refuses local auth on the production boot path', () => {
    expect(() => loadConfig({ ...VALID, NODE_ENV: 'production' })).toThrow(
      /AUTH_MODE=local.*production/,
    );
  });

  it('requires the browser callback origin when OIDC authenticates WebSockets', () => {
    expect(() =>
      loadConfig({
        ...VALID,
        AUTH_MODE: 'oidc',
        AUTH_AUDIENCE: 'wbs-api',
        AUTH_CLIENT_ID: 'client',
        AUTH_CLIENT_SECRET: 'secret',
        AUTH_ISSUER_DISCOVERY_URL: 'https://idp.test',
      }),
    ).toThrow(/AUTH_REDIRECT_URI.*required.*AUTH_MODE=oidc/);
  });

  it('builds the WebSocket verifier and exact allowed origin in OIDC mode', () => {
    const config = loadConfig({
      ...VALID,
      AUTH_MODE: 'oidc',
      AUTH_AUDIENCE: 'wbs-api',
      AUTH_CLIENT_ID: 'client',
      AUTH_CLIENT_SECRET: 'secret',
      AUTH_ISSUER_DISCOVERY_URL: 'https://idp.test',
      AUTH_REDIRECT_URI: 'https://dev.wbs.test/api/auth/okta/callback',
    });

    expect(config.wsAuth?.appOrigin).toBe('https://dev.wbs.test');
    expect(typeof config.wsAuth?.verifier.verify).toBe('function');
  });

  it('turns password-session verification off and back on with the kill switch', async () => {
    const oidcEnv = {
      ...VALID,
      AUTH_MODE: 'oidc',
      AUTH_AUDIENCE: 'wbs-api',
      AUTH_CLIENT_ID: 'client',
      AUTH_CLIENT_SECRET: 'secret',
      AUTH_ISSUER_DISCOVERY_URL: 'https://idp.test',
      AUTH_REDIRECT_URI: 'https://dev.wbs.test/api/auth/okta/callback',
    };
    const oidcVerifier = () => ({
      verify: () => Promise.reject(new Error('not an OIDC token')),
    });
    const token = await new SignJWT({ sub: 'password-user' })
      .setProtectedHeader({ alg: 'HS256' })
      .sign(new TextEncoder().encode(VALID.JWT_SIGNING_KEY_CURRENT));

    const disabled = loadConfig({ ...oidcEnv, AUTH_PASSWORD_LOGIN: 'false' }, oidcVerifier);
    const enabled = loadConfig({ ...oidcEnv, AUTH_PASSWORD_LOGIN: 'true' }, oidcVerifier);

    let disabledError: unknown;
    try {
      await disabled.wsAuth?.verifier?.verify(token);
    } catch (err) {
      disabledError = err;
    }
    expect((disabledError as Error).message).toMatch(/not an OIDC token/);
    expect((await enabled.wsAuth?.verifier?.verify(token))?.sub).toBe('password-user');
  });
});
