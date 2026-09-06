import { describe, expect, it } from 'bun:test';

import { BeConfig, loadConfig } from './config';

const VALID = {
  PORT: '3100',
  INTERNAL_AUTH_SECRET: 'a'.repeat(32),
  LOG_LEVEL: 'info',
  GW_URL: 'http://localhost:3200',
  DB_PATH: '/srv/wbs/data/wbs.db',
  JWT_SIGNING_KEY_CURRENT: 'b'.repeat(32),
  AUTH_MODE: 'local',
};

describe('BeConfig', () => {
  it('accepts a complete environment', () => {
    const parsed = BeConfig(VALID);
    expect(parsed).toMatchObject({ PORT: 3100, DB_PATH: '/srv/wbs/data/wbs.db' });
  });

  // Regression: be-01 previously validated INTERNAL_AUTH_SECRET but never passed
  // it to buildApp, which fell back to a hardcoded constant. Every gw-01 forward
  // 401'd in any real deployment while all tests passed. Keep both keys required
  // so a config missing them fails at startup rather than at the wire.
  // JWT_SIGNING_KEY_CURRENT joins the list for the same reason: be-01 signs
  // the tokens gw-01 verifies, so a missing key must fail at startup rather
  // than as a 401 on every WebSocket handshake.
  for (const key of ['INTERNAL_AUTH_SECRET', 'DB_PATH', 'JWT_SIGNING_KEY_CURRENT'] as const) {
    it(`rejects an environment missing ${key}`, () => {
      const incomplete = Object.fromEntries(Object.entries(VALID).filter(([k]) => k !== key));
      expect(BeConfig(incomplete)).toHaveProperty('summary');
    });
  }

  it('rejects a short INTERNAL_AUTH_SECRET', () => {
    expect(BeConfig({ ...VALID, INTERNAL_AUTH_SECRET: 'too-short' })).toHaveProperty('summary');
  });

  it('refuses local auth on the production boot path', () => {
    expect(() => loadConfig({ ...VALID, NODE_ENV: 'production' })).toThrow(
      /AUTH_MODE=local.*production/,
    );
  });
});

describe('trusted browser origin at startup', () => {
  it('requires a local-mode origin independent of request-like environment values', () => {
    expect(() =>
      loadConfig({ ...VALID, HOST: 'app.example', ORIGIN: 'https://app.example' }),
    ).toThrow('APP_ORIGIN is required');
  });
  for (const origin of [
    '',
    'null',
    'app.example',
    'file:///',
    'file:///app',
    'https://user:password@app.example',
    'https://app.example/path',
    'https://app.example/?query=1',
    'https://app.example/#fragment',
  ]) {
    it(`refuses an invalid configured origin ${origin}`, () => {
      expect(() => loadConfig({ ...VALID, APP_ORIGIN: origin })).toThrow('APP_ORIGIN');
    });
  }
  it('canonicalizes an explicitly configured HTTP origin', () => {
    expect(loadConfig({ ...VALID, APP_ORIGIN: 'http://LOCALHOST:4200/' }).appOrigin).toBe(
      'http://localhost:4200',
    );
  });
  it('uses the configured OIDC callback origin without requiring a local setting', () => {
    expect(
      loadConfig({
        ...VALID,
        AUTH_MODE: 'oidc',
        AUTH_REDIRECT_URI: 'https://app.example/api/auth/okta/callback',
      }).appOrigin,
    ).toBe('https://app.example');
  });
  it('refuses a missing or wrong OIDC callback location', () => {
    expect(() => loadConfig({ ...VALID, AUTH_MODE: 'oidc' })).toThrow('AUTH_REDIRECT_URI');
    expect(() =>
      loadConfig({ ...VALID, AUTH_MODE: 'oidc', AUTH_REDIRECT_URI: 'https://app.example/other' }),
    ).toThrow('AUTH_REDIRECT_URI');
  });
});
