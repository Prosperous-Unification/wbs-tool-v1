import { describe, expect, it } from 'bun:test';

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
  it('refuses local auth on the production boot path', () => {
    expect(() => loadConfig({ ...VALID, NODE_ENV: 'production' })).toThrow(
      /AUTH_MODE=local.*production/,
    );
  });
});
