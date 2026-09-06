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
});
export type BeConfig = typeof BeConfig.infer;

export const loadConfig = (
  envSource: Record<string, string | undefined> = process.env,
): BeConfig & { appOrigin: string } => {
  const mode = authModeOf(envSource);
  const config = defineConfig(BeConfig, envSource);
  const appOrigin =
    mode === 'oidc' ? oidcCallbackUrlFromEnv(envSource).origin : localAppOriginFromEnv(envSource);
  return { ...config, appOrigin };
};

/** The configured callback is also the trusted browser origin in OIDC mode. */
export function oidcCallbackUrlFromEnv(env: Readonly<Record<string, string | undefined>>): URL {
  const callback = configuredUrl(env['AUTH_REDIRECT_URI'], 'AUTH_REDIRECT_URI');
  // Proof: removing this check accepts /other in config.test.ts instead of throwing.
  if (
    callback.pathname !== '/api/auth/okta/callback' ||
    callback.search !== '' ||
    callback.hash !== ''
  ) {
    throw new Error('AUTH_REDIRECT_URI must use the mounted /api/auth/okta/callback route');
  }
  return callback;
}

/** Local authentication still requires an operator-configured browser origin. */
function localAppOriginFromEnv(env: Readonly<Record<string, string | undefined>>): string {
  const origin = configuredUrl(env['APP_ORIGIN'], 'APP_ORIGIN');
  // Proof: removing this check accepts path, query and fragment origins in config.test.ts.
  if (origin.pathname !== '/' || origin.search !== '' || origin.hash !== '') {
    throw new Error('APP_ORIGIN must contain only an HTTP origin');
  }
  return origin.origin;
}

/** Validates trusted configuration without consulting any arriving request headers. */
function configuredUrl(value: string | undefined, key: string): URL {
  // Proof (diagnostic): removing this guard changes the missing-origin test's
  // required-setting error to an absolute-URL error in config.test.ts.
  if (value === undefined || value === '') throw new Error(`${key} is required`);
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new Error(`${key} must be an absolute HTTP URL`, { cause });
  }
  // Proof: removing this check accepts a credential-bearing origin; removing only the
  // protocol condition admits file:/// in config.test.ts.
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new Error(`${key} must be an HTTP URL without credentials`);
  }
  return url;
}
