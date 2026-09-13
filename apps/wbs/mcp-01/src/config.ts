import { mcpAuthModeOf } from '@wbs/auth';
import { type } from '@wbs/validation';

/**
 * mcp-01's whole non-provider configuration: trust mode, be-01 endpoint, and
 * an optional deployment-gate credential. Caller credentials never live here.
 *
 * Nothing here has a default. `WBS_API_URL=http://localhost:3100` would look
 * harmless and then silently edit whichever deployment happened to answer on
 * that port; an MCP server that writes to a plan must not guess which plan.
 * See design.md D3 and D6.
 */
export const McpConfig = type({
  MCP_AUTH_MODE: "'standalone'|'gateway'",
  WBS_API_URL: 'string.url',
  MCP_PUBLIC_URL: 'string.url',
  'MCP_TRUSTED_GATEWAY?': "'true'",
  // `user:pass`. The password may contain colons, the user may not — which is
  // also how an `Authorization: Basic` credential splits.
  'WBS_BASIC_AUTH?': /^[^:\s]+:.+$/,
});
export type McpConfig = typeof McpConfig.infer;

const NAMES = [
  'MCP_AUTH_MODE',
  'WBS_API_URL',
  'MCP_PUBLIC_URL',
  'MCP_TRUSTED_GATEWAY',
  'WBS_BASIC_AUTH',
] as const;

const EXPECTATIONS: Record<(typeof NAMES)[number], string> = {
  MCP_AUTH_MODE: 'standalone or gateway authentication',
  WBS_API_URL: 'the base URL of a be-01 deployment, e.g. https://dev.wbs.bulletpoints.club',
  MCP_PUBLIC_URL:
    'the canonical public MCP resource URL, e.g. https://dev.wbs.bulletpoints.club/mcp',
  MCP_TRUSTED_GATEWAY: 'the exact value true when gateway mode terminates token verification',
  WBS_BASIC_AUTH: 'user:pass for the deployment’s basic auth, or unset',
};

/**
 * Reads the MCP variables and nothing else.
 *
 * The narrow read is the point, and the reason has changed. It was that
 * `defineConfig` handed its whole env source to `parseOrThrow`, which put
 * `JSON.stringify(input)` in the thrown message — so a boot failure printed the
 * env, and for a process whose env is one account's token and one basic-auth
 * password it printed the credentials. `defineConfig` goes through
 * `parseSecretsOrThrow` now and names variables only, so that hazard is closed
 * at the source.
 *
 * What remains is this file's own reason to stay narrow: it reads the MCP
 * variables and nothing else, so a variable belonging to another tier cannot
 * reach an MCP refusal at all. The message here names variables and never
 * values, which is the same rule one layer up.
 */
export const loadConfig = (env: Record<string, string | undefined> = process.env): McpConfig => {
  const mode = mcpAuthModeOf(env);
  if (mode === 'gateway' && env['MCP_TRUSTED_GATEWAY'] !== 'true') {
    throw new Error('mcp-01 cannot start: MCP_TRUSTED_GATEWAY=true is required in gateway mode');
  }
  const picked: Record<string, string> = {};
  for (const name of NAMES) {
    const value = env[name];
    // An empty string is an unset variable that went through a shell, not a
    // An empty shell variable is absent, not a usable configuration value.
    if (value !== undefined && value !== '') picked[name] = value;
  }

  const result = McpConfig(picked);
  if (!(result instanceof type.errors)) return result;

  const faults = [...new Set(result.map((error) => String(error.path[0])))]
    .filter((name): name is (typeof NAMES)[number] => name in EXPECTATIONS)
    .map((name) =>
      name in picked
        ? `${name} is set but invalid (expected ${EXPECTATIONS[name]})`
        : `${name} is required (${EXPECTATIONS[name]})`,
    );

  // The fallback names no value either. `result.summary` would, and a summary
  // is exactly the kind of thing that gets logged.
  throw new Error(
    `mcp-01 cannot start: ${
      faults.length > 0 ? faults.join('; ') : 'the environment did not match the expected shape'
    }. These have no defaults on purpose — see apps/mcp-01/README.md.`,
  );
};
