import { authModeOf } from '@wbs/auth';
import { defineConfig } from '@wbs/config';
import { type } from '@wbs/validation';

export const BeConfig = type({
  PORT: 'string.integer.parse',
  INTERNAL_AUTH_SECRET: 'string>=32',
  LOG_LEVEL: "'trace'|'debug'|'info'|'warn'|'error'|'fatal'",
  GW_URL: 'string',
  // Required rather than defaulted: a fallback like './local.db' puts the
  // database inside the checkout, where a re-clone or `git clean` erases it.
  DB_PATH: 'string>0',
  // The same value gw-01 verifies WebSocket tokens with. Held to the same
  // >=32 bound as gw-01's copy so a short key fails at both ends or neither.
  JWT_SIGNING_KEY_CURRENT: 'string>=32',
  AUTH_MODE: "'local'|'oidc'",
  'SOLVER_BUDGET_MS?': 'string.integer.parse',
});
export type BeConfig = Omit<typeof BeConfig.infer, 'SOLVER_BUDGET_MS'> & {
  SOLVER_BUDGET_MS: number;
};

export const loadConfig = (
  envSource: Record<string, string | undefined> = process.env,
): BeConfig => {
  authModeOf(envSource);
  const config = defineConfig(BeConfig, envSource);
  const solverBudgetMs = config.SOLVER_BUDGET_MS ?? 60_000;
  if (solverBudgetMs <= 0) throw new Error('SOLVER_BUDGET_MS must be greater than zero');
  return { ...config, SOLVER_BUDGET_MS: solverBudgetMs };
};
