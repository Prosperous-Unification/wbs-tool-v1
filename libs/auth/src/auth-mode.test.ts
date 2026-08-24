import { describe, expect, it } from 'bun:test';

import { authModeOf, mcpAuthModeOf } from './auth-mode';

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
