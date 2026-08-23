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
