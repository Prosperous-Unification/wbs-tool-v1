import { type } from '@wbs/validation';

/**
 * mcp-01's whole configuration: where be-01 is, the token to speak to it with,
 * and — for the dev deployment, which sits behind basic auth on every path but
 * `/ws*` — an optional `user:pass`.
 *
 * Nothing here has a default. `WBS_API_URL=http://localhost:3100` would look
 * harmless and then silently edit whichever deployment happened to answer on
 * that port; an MCP server that writes to a plan must not guess which plan.
 * See design.md D3 and D6.
 */
export const McpConfig = type({
  WBS_API_URL: 'string.url',
  WBS_TOKEN: 'string>0',
  // `user:pass`. The password may contain colons, the user may not — which is
  // also how an `Authorization: Basic` credential splits.
  'WBS_BASIC_AUTH?': /^[^:\s]+:.+$/,
});
export type McpConfig = typeof McpConfig.infer;

const NAMES = ['WBS_API_URL', 'WBS_TOKEN', 'WBS_BASIC_AUTH'] as const;

const EXPECTATIONS: Record<(typeof NAMES)[number], string> = {
  WBS_API_URL: 'the base URL of a be-01 deployment, e.g. https://dev.wbs.bulletpoints.club',
  WBS_TOKEN: 'a be-01 account token (12-hour lifetime, no scope — design.md D6)',
  WBS_BASIC_AUTH: 'user:pass for the deployment’s basic auth, or unset',
};

/**
 * Reads the three variables and nothing else.
 *
 * The narrow read is the point: `defineConfig` hands its whole env source to
 * `parseOrThrow`, which puts `JSON.stringify(input)` in the thrown message. For
 * be-01 and gw-01 that prints their env on a boot failure; for a process whose
 * env is one account's token and one basic-auth password, it would print the
 * credentials. So the message here names variables and never values.
 */
export const loadConfig = (env: Record<string, string | undefined> = process.env): McpConfig => {
  const picked: Record<string, string> = {};
  for (const name of NAMES) {
    const value = env[name];
    // An empty string is an unset variable that went through a shell, not a
    // value: `WBS_TOKEN=` must read the same as no `WBS_TOKEN` at all.
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
