export type AuthMode = 'local' | 'oidc';

export type McpAuthMode = 'standalone' | 'gateway';

type Environment = Readonly<Record<string, string | undefined>>;

/** Reads a defaulted security flag without accepting misspellings as policy. */
export function booleanFlagOf(env: Environment, key: string, fallback: boolean): boolean {
  const value = env[key];
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${key} must be true or false`);
}

/**
 * Reads the application authentication mode without a permissive default.
 *
 * @throws When the mode is absent, unknown, or local in production.
 */
export function authModeOf(env: Environment = process.env): AuthMode {
  const mode = env['AUTH_MODE'];
  // Proof: `refuses a missing or unknown mode` fails when absence or an
  // unrecognised value is allowed through this boundary.
  if (mode === undefined || mode === '') {
    throw new Error('AUTH_MODE is required (local or oidc)');
  }
  if (mode !== 'local' && mode !== 'oidc') {
    throw new Error('AUTH_MODE must be local or oidc');
  }
  // Proof: `refuses local mode in production` fails if this guard is removed.
  if (mode === 'local' && env['NODE_ENV'] === 'production') {
    throw new Error('AUTH_MODE=local is forbidden in production');
  }
  return mode;
}

/**
 * Reads the MCP authentication mode without guessing which trust boundary owns
 * token verification.
 *
 * @throws When the mode is absent or unknown.
 */
export function mcpAuthModeOf(env: Environment = process.env): McpAuthMode {
  const mode = env['MCP_AUTH_MODE'];
  // Proof: `refuses a missing or unknown mode` fails when this boundary
  // defaults or accepts an unrecognised trust mode.
  if (mode === undefined || mode === '') {
    throw new Error('MCP_AUTH_MODE is required (standalone or gateway)');
  }
  if (mode !== 'standalone' && mode !== 'gateway') {
    throw new Error('MCP_AUTH_MODE must be standalone or gateway');
  }
  return mode;
}
