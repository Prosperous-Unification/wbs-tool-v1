import { randomBytes } from 'node:crypto';

import {
  booleanFlagOf,
  browserOidcClientFromEnv,
  InMemoryOidcTransactionStore,
  InMemoryTokenStore,
  oidcTokenVerifierFromEnv,
  type OidcTransactionStore,
  type TokenStore,
  type TokenVerifier,
} from '@wbs/auth';

import { oidcCallbackUrlFromEnv } from '../config';

/** Logger surface used by browser authentication without naming its runtime implementation. */
export interface AuthRouteLog {
  info: (fields: Record<string, unknown>, message: string) => void;
  warn: (fields: Record<string, unknown>, message: string) => void;
  error: (fields: Record<string, unknown>, message: string) => void;
}

/** Provider, state and optional password settings for the OIDC app composition. */
export interface OidcRouteOptions {
  appOrigin: string;
  client: ReturnType<typeof browserOidcClientFromEnv>;
  groupPrefix: string;
  groupsClaim: string;
  logger?: AuthRouteLog;
  mode: 'oidc';
  now?: () => number;
  passwordLoginEnabled?: boolean;
  passwordRegisterEnabled?: boolean;
  random?: () => string;
  redirectUri: string;
  tokens: TokenStore;
  transactions: OidcTransactionStore;
  verifier: TokenVerifier;
}

/** Builds the OIDC composition from validated operator configuration. */
export function oidcRouteOptionsFromEnv(env: Record<string, string | undefined>): OidcRouteOptions {
  for (const key of [
    'AUTH_ISSUER_DISCOVERY_URL',
    'AUTH_CLIENT_ID',
    'AUTH_CLIENT_SECRET',
    'AUTH_REDIRECT_URI',
  ]) {
    if (env[key] === undefined || env[key] === '')
      throw new Error(`${key} is required in AUTH_MODE=oidc`);
  }
  const redirectUri = oidcCallbackUrlFromEnv(env);
  const passwordLoginEnabled = booleanFlagOf(env, 'AUTH_PASSWORD_LOGIN', true);
  const passwordRegisterEnabled = booleanFlagOf(env, 'AUTH_PASSWORD_REGISTER', false);
  if (passwordRegisterEnabled && !passwordLoginEnabled) {
    throw new Error('AUTH_PASSWORD_REGISTER=true requires AUTH_PASSWORD_LOGIN=true');
  }
  return {
    appOrigin: redirectUri.origin,
    client: browserOidcClientFromEnv(env),
    groupPrefix: env['NODE_ENV'] === 'production' ? 'prod' : 'dev',
    groupsClaim: env['AUTH_GROUPS_CLAIM'] ?? 'wbs_groups',
    mode: 'oidc',
    passwordLoginEnabled,
    passwordRegisterEnabled,
    random: () => randomBytes(32).toString('base64url'),
    redirectUri: redirectUri.href,
    tokens: new InMemoryTokenStore(),
    transactions: new InMemoryOidcTransactionStore({ ttlMs: 300_000 }),
    verifier: oidcTokenVerifierFromEnv(env),
  };
}
