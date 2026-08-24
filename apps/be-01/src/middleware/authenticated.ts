import type { AuthenticatedUser, AuthService } from '../service/auth.service';

/**
 * The app token from the hardened browser cookie or standard Bearer header.
 *
 * The retired `x-wbs-token` header is deliberately ignored. Proof:
 * `auth.integration.test.ts` restores that header and observes a 200 instead of
 * the required 401.
 */
export function tokenFromHeaders(headers: Record<string, string | undefined>): string | null {
  const cookie = cookieValue(headers['cookie'], '__Host-wbs_access');
  const bearer = headers['authorization'];
  return cookie ?? (bearer?.startsWith('Bearer ') === true ? bearer.slice(7) : null);
}

/** The authenticated account, or null when the request carries no usable token. */
export async function userFromHeaders(
  auth: AuthService,
  headers: Record<string, string | undefined>,
): Promise<AuthenticatedUser | null> {
  return auth.authenticate(tokenFromHeaders(headers));
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
