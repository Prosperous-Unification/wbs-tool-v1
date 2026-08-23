import { authModeOf } from '@wbs/auth';
import { defineConfig } from '@wbs/config';
import { type } from '@wbs/validation';

export const GwConfig = type({
  PORT: 'string.integer.parse',
  LOG_LEVEL: "'trace'|'debug'|'info'|'warn'|'error'|'fatal'",
  BE_URL: 'string',
  INTERNAL_AUTH_SECRET: 'string>=32',
  JWT_SIGNING_KEY_CURRENT: 'string>=32',
  'JWT_SIGNING_KEY_PREVIOUS?': 'string>=32',
  AUTH_MODE: "'local'|'oidc'",
});
export type GwConfig = typeof GwConfig.infer;

export const loadConfig = (
  envSource: Record<string, string | undefined> = process.env,
): GwConfig => {
  authModeOf(envSource);
  return defineConfig(GwConfig, envSource);
};
