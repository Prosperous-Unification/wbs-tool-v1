import type { Color } from '@tools/deploy-contract';

// Re-exported because this module's callers take the word from here. Declared
// in its own words until 2026-09-02 — one of three copies of a two-colour
// union across the deploy tools.
export type { Color };

/**
 * Resolves which colour is live from `SMOKE_COLOR`. Deliberately never
 * defaults to "blue" (or anything else): the live colour alternates with
 * every blue/green deploy, so a silent default would eventually run every
 * check against the DEAD colour with no indication anything was wrong. A
 * missing or invalid value fails loudly instead — see the task brief's
 * ambiguity note ("do not hardcode blue").
 */
export function resolveColor(env: NodeJS.ProcessEnv = process.env): Color {
  const value = env['SMOKE_COLOR'];
  if (value === 'blue' || value === 'green') return value;
  throw new Error(
    `SMOKE_COLOR must be "blue" or "green" (got ${value === undefined ? '(unset)' : JSON.stringify(value)}) — ` +
      'smoke refuses to assume which colour is live',
  );
}
