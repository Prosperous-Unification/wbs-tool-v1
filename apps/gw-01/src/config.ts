import { authModeOf, oidcTokenVerifierFromEnv, type TokenVerifier } from '@wbs/auth';
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

export interface WsAuthOptions {
  appOrigin?: string;
  verifier?: TokenVerifier;
  localIdentity?: string;
}

export function oidcAppOriginFromEnv(env: Readonly<Record<string, string | undefined>>): string {
  const redirectUri = env['AUTH_REDIRECT_URI'];
  if (redirectUri === undefined || redirectUri === '') {
    throw new Error('AUTH_REDIRECT_URI is required in AUTH_MODE=oidc');
  }
  return new URL(redirectUri).origin;
}

export const loadConfig = (
  envSource: Record<string, string | undefined> = process.env,
): GwConfig & { wsAuth?: WsAuthOptions } => {
  const mode = authModeOf(envSource);
  const config = defineConfig(GwConfig, envSource);
  if (mode === 'local') {
    return { ...config, wsAuth: { localIdentity: 'local-dev' } };
  }
  return {
    ...config,
    wsAuth: {
      appOrigin: oidcAppOriginFromEnv(envSource),
      verifier: oidcTokenVerifierFromEnv(envSource),
    },
  };
};
