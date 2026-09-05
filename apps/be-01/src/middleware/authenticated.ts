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

/**
 * Every cookie on the request, by name, with values **as sent** — still
 * percent-encoded.
 *
 * Undecoded on purpose, because the two callers want different things of a
 * malformed value: {@link tokenFromHeaders} reads one value and treats an
 * undecodable one as no cookie at all (so a Bearer header still gets its
 * chance), while `hasInvalidCookieOrigin` only asks **whether** a session
 * cookie is there and must not care. Decoding here would force one answer on
 * both — and did: the copy in `auth.routes.ts` decoded every value to read
 * none of them, so a single malformed `%` in any cookie threw a `URIError` out
 * of `onRequest` and answered 500 to a request the origin check had no quarrel
 * with.
 *
 * A name with no `=`, or one starting with `=`, is skipped rather than stored
 * under an empty name: `separator > 0` is the same test both copies made.
 */
export function cookiesIn(raw: string | undefined): Map<string, string> {
  const parsed = new Map<string, string>();
  for (const part of (raw ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator > 0) parsed.set(part.slice(0, separator).trim(), part.slice(separator + 1));
  }
  return parsed;
}

/**
 * One cookie, decoded, or `null` when it is absent or cannot be decoded.
 *
 * An undecodable value reads as absent rather than throwing, which is the
 * reading every caller wants: a cookie nobody can decode is not a token and is
 * not a correlation id, and a `URIError` out of a request handler is a 500
 * about a malformed request — the one thing R5 says an Elysia route must not
 * do.
 */
export function cookieValue(raw: string | undefined, name: string): string | null {
  const sent = cookiesIn(raw).get(name);
  if (sent === undefined) return null;
  try {
    return decodeURIComponent(sent);
  } catch {
    return null;
  }
}
