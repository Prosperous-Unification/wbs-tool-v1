/**
 * What this project calls a failed OIDC exchange, so a caller can answer one
 * status for "you did not sign in" and another for "the provider is gone".
 *
 * Today every way out of `exchange` reaches the callback as the same rejected
 * promise, so during a provider outage every login looks like a caller
 * authentication failure and no alert can tell the two apart. The classification
 * is owned here rather than in the route because the alternative — the route
 * reading the library's error subclasses — puts a dependency's internals in a
 * controller and is wrong the day the library adds one.
 *
 * **Nothing here names a library class.** `oauth4webapi`, which `openid-client`
 * is built on, puts a stable exported string constant on `error.code`
 * (`OAUTH_RESPONSE_BODY_ERROR` and friends). Matching a string is not matching a
 * subclass: a class this file never mentions can be added, renamed or split
 * without touching it, and an unrecognised code lands in `defect` rather than
 * being silently read as a refusal.
 */
export type OidcFailureKind = 'refused' | 'unavailable' | 'defect';

export interface OidcFailure {
  /**
   * `refused` — the sign-in did not happen and re-trying it is the reader's
   * move: a spent or wrong `code`, rejected client credentials, an ID token
   * whose claims do not check out.
   *
   * `unavailable` — the identity provider could not be reached or did not
   * answer as itself. Nobody's credentials were wrong; retrying later is the
   * move.
   *
   * `defect` — anything this project does not recognise, including its own
   * configuration being wrong. Deliberately not folded into `refused`: an
   * unknown failure is not evidence that a person typed something wrong.
   */
  readonly kind: OidcFailureKind;
  /**
   * A short slug this project owns, for the log line an outage is grepped by.
   * Never a provider string and never sent to a browser.
   */
  readonly reason: string;
}

/**
 * `error.code` values that mean the sign-in was refused.
 *
 * `OAUTH_RESPONSE_BODY_ERROR` is the common one: the token endpoint answered a
 * well-formed OAuth error, which for a callback is almost always `invalid_grant`
 * — a `code` already spent, expired, or issued to someone else.
 */
const REFUSED_CODES: ReadonlySet<string> = new Set([
  'OAUTH_AUTHORIZATION_RESPONSE_ERROR',
  'OAUTH_RESPONSE_BODY_ERROR',
  'OAUTH_WWW_AUTHENTICATE_CHALLENGE',
  'OAUTH_JWT_TIMESTAMP_CHECK_FAILED',
  'OAUTH_JWT_CLAIM_COMPARISON_FAILED',
]);

/**
 * `error.code` values that mean the provider did not answer as itself.
 *
 * A response that will not parse as JSON is filed here rather than as a defect
 * because the realistic producer is a load balancer serving an HTML error page
 * during an outage. The two mistakes cost differently: an outage filed as a
 * defect is an outage nobody pages for, while a defect filed as an outage is a
 * noisy alert that gets read.
 */
const UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  'OAUTH_PARSE_ERROR',
  'OAUTH_RESPONSE_IS_NOT_JSON',
  'OAUTH_RESPONSE_IS_NOT_CONFORM',
]);

/**
 * Transport failures, which arrive with no `code` of their own.
 *
 * `fetch` rejects with a bare `TypeError` and hangs the real cause off `cause`,
 * so DNS, connection and TLS failures are only distinguishable one level down.
 * This is also the arm a failed *discovery* reaches: `exchange` awaits discovery
 * before it touches the token endpoint, so an unreachable issuer surfaces as a
 * failed exchange rather than as anything of its own.
 */
const TRANSPORT_CODE =
  /^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPROTO|UND_ERR_|CERT_|ERR_TLS_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT)/;

function codeOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const code: unknown = (value as { code?: unknown }).code;
  return typeof code === 'string' && code !== '' ? code : undefined;
}

/** Walks `cause` for a transport code, since `fetch` buries it one or more levels down. */
function transportCodeOf(value: unknown, depth = 0): string | undefined {
  if (depth > 4 || typeof value !== 'object' || value === null) return undefined;
  const code = codeOf(value);
  if (code !== undefined && TRANSPORT_CODE.test(code)) return code;
  return transportCodeOf((value as { cause?: unknown }).cause, depth + 1);
}

/**
 * Classifies whatever `exchange` rejected with.
 *
 * Takes `unknown` on purpose: a `catch` binding is `unknown`, and the point of
 * this function is that the caller never has to narrow it itself.
 */
export function classifyOidcFailure(error: unknown): OidcFailure {
  const transport = transportCodeOf(error);
  if (transport !== undefined) return { kind: 'unavailable', reason: `transport:${transport}` };

  const code = codeOf(error);
  if (code === undefined) return { kind: 'defect', reason: 'unclassified' };
  if (REFUSED_CODES.has(code)) return { kind: 'refused', reason: code };
  if (UNAVAILABLE_CODES.has(code)) return { kind: 'unavailable', reason: code };
  return { kind: 'defect', reason: code };
}
