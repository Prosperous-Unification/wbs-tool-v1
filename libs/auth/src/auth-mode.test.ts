import { describe, expect, it } from 'bun:test';

import { authModeOf, booleanFlagOf, mcpAuthModeOf } from './auth-mode';

describe('authModeOf', () => {
  it('accepts oidc in production', () => {
    expect(authModeOf({ AUTH_MODE: 'oidc', NODE_ENV: 'production' })).toBe('oidc');
  });

  it('accepts local outside production', () => {
    expect(authModeOf({ AUTH_MODE: 'local', NODE_ENV: 'development' })).toBe('local');
  });

  it('refuses a missing or unknown mode', () => {
    expect(() => authModeOf({ NODE_ENV: 'development' })).toThrow(/AUTH_MODE.*required/);
    expect(() => authModeOf({ AUTH_MODE: 'anything', NODE_ENV: 'development' })).toThrow(
      /AUTH_MODE.*local.*oidc/,
    );
  });

  it('refuses local mode in production', () => {
    expect(() => authModeOf({ AUTH_MODE: 'local', NODE_ENV: 'production' })).toThrow(
      /AUTH_MODE=local.*production/,
    );
  });
});

describe('mcpAuthModeOf', () => {
  it('accepts standalone and gateway', () => {
    expect(mcpAuthModeOf({ MCP_AUTH_MODE: 'standalone' })).toBe('standalone');
    expect(mcpAuthModeOf({ MCP_AUTH_MODE: 'gateway' })).toBe('gateway');
  });

  it('refuses a missing or unknown mode', () => {
    expect(() => mcpAuthModeOf({})).toThrow(/MCP_AUTH_MODE.*required/);
    expect(() => mcpAuthModeOf({ MCP_AUTH_MODE: 'anything' })).toThrow(
      /MCP_AUTH_MODE.*standalone.*gateway/,
    );
  });
});

describe('booleanFlagOf', () => {
  it('uses the declared default and accepts only literal booleans', () => {
    expect(booleanFlagOf({}, 'AUTH_PASSWORD_LOGIN', true)).toBe(true);
    expect(booleanFlagOf({ AUTH_PASSWORD_LOGIN: 'false' }, 'AUTH_PASSWORD_LOGIN', true)).toBe(
      false,
    );
    expect(booleanFlagOf({ AUTH_PASSWORD_LOGIN: 'true' }, 'AUTH_PASSWORD_LOGIN', false)).toBe(
      true,
    );
  });

  it('refuses a misspelled security flag instead of silently choosing a mode', () => {
    expect(() =>
      booleanFlagOf({ AUTH_PASSWORD_LOGIN: 'TRUE' }, 'AUTH_PASSWORD_LOGIN', true),
    ).toThrow(/AUTH_PASSWORD_LOGIN.*true.*false/);
  });
});
