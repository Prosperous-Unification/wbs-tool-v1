import type { AuthenticatedUser, AuthService } from '../service/auth.service';

/**
 * The app token, from either header the front end may have used.
 *
 * `x-wbs-token` is the one it does use, and the reason was the dev edge: while
 * dev sat behind basic auth, an `Authorization: Bearer` from the app *replaced*
 * the `Authorization: Basic` credential Caddy required, Caddy 401'd before be-01
 * was reached, and the failure looked like a rejected app token rather than a
 * missing proxy credential.
 *
 * Dev's password was removed 2026-08-06 and the collision cannot happen there
 * now. The header stays anyway: a header no edge reads cannot collide with one
 * it does, which is true of every proxy this may sit behind later, and changing
 * it back would be churn with a known failure mode and no gain.
 */
export function tokenFromHeaders(headers: Record<string, string | undefined>): string | null {
  const cookie = cookieValue(headers['cookie'], '__Host-wbs_access');
  const bearer = headers['authorization'];
  return (
    cookie ??
    headers['x-wbs-token'] ??
    (bearer?.startsWith('Bearer ') === true ? bearer.slice(7) : null)
  );
}

/** The authenticated account, or null when the request carries no usable token. */
export async function userFromHeaders(
  auth: AuthService,
  headers: Record<string, string | undefined>,
): Promise<AuthenticatedUser | null> {
  const token = tokenFromHeaders(headers);
  if (token === null) return null;
  return auth.authenticate(token);
}

function cookieValue(raw: string | undefined, name: string): string | null {
  for (const part of (raw ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator > 0 && part.slice(0, separator).trim() === name) {
      try {
        return decodeURIComponent(part.slice(separator + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}
