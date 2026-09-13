import { authModeOf, booleanFlagOf, oidcTokenVerifierFromEnv, type TokenVerifier } from '@wbs/auth';
import { defineConfig } from '@wbs/config';
import { type } from '@wbs/validation';

import { JwtVerifier } from './service/jwt-auth';

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
  oidcVerifierFromEnv: typeof oidcTokenVerifierFromEnv = oidcTokenVerifierFromEnv,
): GwConfig & { wsAuth?: WsAuthOptions } => {
  const mode = authModeOf(envSource);
  const config = defineConfig(GwConfig, envSource);
  if (mode === 'local') {
    return { ...config, wsAuth: { localIdentity: 'local-dev' } };
  }
  const oidcVerifier = oidcVerifierFromEnv(envSource);
  const passwordLoginEnabled = booleanFlagOf(envSource, 'AUTH_PASSWORD_LOGIN', true);
  return {
    ...config,
    wsAuth: {
      appOrigin: oidcAppOriginFromEnv(envSource),
      verifier: passwordLoginEnabled
        ? new JwtVerifier({
            current: new TextEncoder().encode(config.JWT_SIGNING_KEY_CURRENT),
            previous: config.JWT_SIGNING_KEY_PREVIOUS
              ? new TextEncoder().encode(config.JWT_SIGNING_KEY_PREVIOUS)
              : undefined,
            primary: oidcVerifier,
          })
        : oidcVerifier,
    },
  };
};
