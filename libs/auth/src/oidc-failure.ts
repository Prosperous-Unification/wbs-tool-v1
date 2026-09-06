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
 * (`OAUTH_RESPONSE_BODY_ERROR` and friends) and, for the two error responses
 * that carry one, the RFC 6749 error value on `error.error`. Matching strings is
 * not matching a subclass: a class this file never mentions can be added,
 * renamed or split without touching it, and an unrecognised code lands in
 * `defect` rather than being silently read as a refusal.
 *
 * **The question every row answers is whose move it is.** A person retries a
 * refusal, everybody waits out an unavailability, and an operator is paged for a
 * defect. That is why our own client credentials being rejected is a `defect`
 * and not a `refused`: nobody typed anything wrong, and filing it as a refusal
 * would put an operator's outage back into the bucket this task exists to empty.
 *
 * `indeterminate` is the fourth answer, and it is the honest one: some evidence
 * we fully understand still does not say whose move it is. A taxonomy built on
 * that question needs a value for "this does not answer it", or the row gets
 * assigned by whoever argued last. See {@link UNATTRIBUTED_ALERT}.
 */
export type OidcFailureKind = 'refused' | 'unavailable' | 'defect' | 'indeterminate';

/**
 * Every slug this module can produce, written by this project and closed on
 * purpose: the doc comment on {@link OidcFailure.reason} promises the log line
 * never carries a library- or provider-controlled string, and a union is how
 * that promise is kept rather than asserted.
 */
export type OidcFailureReason =
  | 'grant_refused'
  | 'claims_refused'
  | 'provider_unreachable'
  | 'provider_reported_outage'
  | 'provider_response_unusable'
  | 'client_authentication_failed'
  | 'request_rejected'
  | 'local_defect'
  | 'tls_negotiation_failed'
  | 'unrecognised_failure'
  | 'unreadable_failure';

/**
 * Thrown by the readers below when the value handed to the classifier will not
 * let itself be read — a property getter that throws.
 *
 * It exists so the boundary can stay total *and* stay honest: a hostile getter
 * and a regression inside this module both end as `defect`, but they end with
 * different slugs, so one is not mistaken for the other in the log.
 */
class UnreadableValue extends Error {}

export interface OidcFailure {
  /**
   * `refused` — the sign-in did not happen and re-trying it is the reader's
   * move: a spent or wrong `code`, a consent that was declined, an ID token
   * whose claims do not check out.
   *
   * `unavailable` — the identity provider could not be reached, said it was
   * failing, or did not answer as itself. Nobody's credentials were wrong;
   * retrying later is the move.
   *
   * `defect` — this deployment is wrong, or the failure is one this project does
   * not recognise. Deliberately not folded into `refused`: an unknown failure is
   * not evidence that a person typed something wrong.
   *
   * `indeterminate` — the failure is understood and it names an outcome without
   * naming a party, so either end could be the one that has to change. The
   * caller's move is an unavailability's — nothing was served and retrying later
   * is all a person can do — but the alert is not an outage's, because there may
   * be nothing on the far end to recover. Kept apart from `unavailable` so a
   * dashboard is never told a provider is down on evidence that does not say so.
   */
  readonly kind: OidcFailureKind;
  /**
   * A short slug this project owns, for the log line an outage is grepped by.
   * Never a provider or library string and never sent to a browser — see
   * {@link OidcFailureReason}, which is closed so this cannot drift.
   */
  readonly reason: OidcFailureReason;
}

const REFUSED = (reason: OidcFailureReason): OidcFailure => ({ kind: 'refused', reason });
const UNAVAILABLE = (reason: OidcFailureReason): OidcFailure => ({ kind: 'unavailable', reason });
const DEFECT = (reason: OidcFailureReason): OidcFailure => ({ kind: 'defect', reason });
const INDETERMINATE = (reason: OidcFailureReason): OidcFailure => ({
  kind: 'indeterminate',
  reason,
});

/**
 * RFC 6749 / OIDC error values, which arrive on `error.error` for both the
 * authorization response and the token response.
 *
 * The token endpoint's answer is the row that matters most here: an overloaded
 * or failing provider replies with a well-formed OAuth error body — typically
 * `server_error` or `temporarily_unavailable` under a 5xx — so reading the
 * envelope alone and calling it a refusal would classify the outage this task
 * exists to separate as a caller authentication failure.
 *
 * This is a design proven by a case per row below, **not a measured fact**: no
 * provider was observed emitting each of these. What is measured is that each
 * row lands where the table says it does.
 */
const OAUTH_ERROR_VALUES: ReadonlyMap<string, OidcFailure> = new Map([
  // The person's move: sign in again, or grant the consent that was declined.
  ['invalid_grant', REFUSED('grant_refused')],
  ['access_denied', REFUSED('grant_refused')],
  ['login_required', REFUSED('grant_refused')],
  ['consent_required', REFUSED('grant_refused')],
  ['interaction_required', REFUSED('grant_refused')],
  ['account_selection_required', REFUSED('grant_refused')],

  // Nobody's move but time's.
  ['server_error', UNAVAILABLE('provider_reported_outage')],
  ['temporarily_unavailable', UNAVAILABLE('provider_reported_outage')],

  // An operator's move: this deployment is registered or configured wrongly.
  ['invalid_client', DEFECT('client_authentication_failed')],
  ['unauthorized_client', DEFECT('client_authentication_failed')],
  ['invalid_request', DEFECT('request_rejected')],
  ['invalid_scope', DEFECT('request_rejected')],
  ['unsupported_grant_type', DEFECT('request_rejected')],
  ['unsupported_response_type', DEFECT('request_rejected')],
]);

/** `error.code` values whose meaning does not depend on an OAuth error value. */
const CODE_TABLE: ReadonlyMap<string, OidcFailure> = new Map([
  // The ID token arrived and its claims did not check out.
  ['OAUTH_JWT_TIMESTAMP_CHECK_FAILED', REFUSED('claims_refused')],
  ['OAUTH_JWT_CLAIM_COMPARISON_FAILED', REFUSED('claims_refused')],

  // The provider did not answer as itself. `OAUTH_RESPONSE_IS_NOT_CONFORM` is
  // the library's code for an unexpected HTTP status, which is exactly the shape
  // a gateway's 502 takes; `OAUTH_RESPONSE_IS_NOT_JSON` is an unexpected media
  // type, which is that gateway's HTML error page.
  ['OAUTH_RESPONSE_IS_NOT_CONFORM', UNAVAILABLE('provider_response_unusable')],
  ['OAUTH_RESPONSE_IS_NOT_JSON', UNAVAILABLE('provider_response_unusable')],
  // `OAUTH_INVALID_RESPONSE` is deliberately absent from this row, though it
  // reads like it belongs: the library also raises it for a missing or
  // unexpected `state`, `iss` or `code` — a callback that was malformed or
  // tampered with, which is nothing like a provider being down. It falls to
  // `unrecognised_failure`, which is the conservative arm for a code whose
  // meaning depends on context this module cannot see.

  // An operator's move. A rejected `WWW-Authenticate` challenge at the token
  // endpoint means our client credentials were refused, not a person's.
  ['OAUTH_WWW_AUTHENTICATE_CHALLENGE', DEFECT('client_authentication_failed')],
  ['OAUTH_INVALID_REQUEST', DEFECT('request_rejected')],
  ['OAUTH_UNSUPPORTED_OPERATION', DEFECT('local_defect')],
  // Documented as covering JWS/JWE headers, JSON bodies and the request
  // parameters this project authors, so it is not evidence of an outage.
  ['OAUTH_PARSE_ERROR', DEFECT('local_defect')],
]);

/** Envelope codes that carry an RFC 6749 error value worth reading. */
const OAUTH_ERROR_ENVELOPES: ReadonlySet<string> = new Set([
  'OAUTH_RESPONSE_BODY_ERROR',
  'OAUTH_AUTHORIZATION_RESPONSE_ERROR',
]);

/**
 * Transport failures, which arrive with no OAuth code of their own.
 *
 * `fetch` rejects with a bare `TypeError` and hangs the real cause off `cause`,
 * so DNS, connection and TLS failures are only distinguishable one level down.
 * This is also the arm a failed *discovery* reaches: `exchange` awaits discovery
 * before it touches the token endpoint, so an unreachable issuer surfaces as a
 * failed exchange rather than as anything of its own.
 *
 * Enumerated rather than prefix-matched. `UND_ERR_` covers `UND_ERR_INVALID_ARG`
 * and `UND_ERR_NOT_SUPPORTED` as well as the timeouts — argument and programming
 * errors — so a prefix would let one of our own defects wear an outage's badge.
 *
 * Undici's *lifecycle* codes are deliberately absent for the same reason.
 * `UND_ERR_CLOSED` and `UND_ERR_DESTROYED` mean this process tore its own
 * dispatcher down, and `UND_ERR_ABORTED` can be a cancellation we asked for;
 * none of the three is evidence about the provider, and because the transport
 * walk runs before the OAuth table, listing them would have quietly overruled
 * every other row. The timeouts below are the codes that do carry that evidence.
 */
const TRANSPORT_CODES: ReadonlySet<string> = new Set([
  // Name resolution, connection, and socket.
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETUNREACH',
  'ENETDOWN',
  'EPIPE',
  'EPROTO',
  // Undici, named one by one for the reason above.
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_REQ_RETRY',
  'UND_ERR_PRX_TLS',
  'UND_ERR_RES_CONTENT_LENGTH_MISMATCH',
  // TLS: an unusable certificate makes the provider unreachable, whoever's
  // fault it is, and waiting is the only move a caller has.
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_SIGNATURE_FAILURE',
  'CERT_REVOKED',
  'CERT_UNTRUSTED',
  'CERT_CHAIN_TOO_LONG',
  'CERT_REJECTED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_TLS_HANDSHAKE_TIMEOUT',
  'HOSTNAME_MISMATCH',
  // OpenSSL failures that are not alerts but are still about what came back
  // over the wire: a peer speaking a protocol we cannot, or a middlebox
  // answering in something that is not TLS at all.
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_UNSUPPORTED_PROTOCOL',
  'ERR_SSL_PACKET_LENGTH_TOO_LONG',
]);

/**
 * The one open-ended rule left, and it matches an alert rather than a namespace.
 *
 * Node surfaces the far end's TLS alerts verbatim —
 * `ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE`, `ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION`,
 * `ERR_SSL_TLSV13_ALERT_*` and an open tail of others. An alert is by definition
 * something the peer sent us, so the whole shape is evidence about the peer, and
 * one added tomorrow is still an alert. Anything a closed list could say about
 * that family it would say too late.
 *
 * **`ERR_SSL_` on its own would not do**, which is the same mistake as the
 * `UND_ERR_` prefix in a different coat: it is OpenSSL's whole namespace, and
 * `ERR_SSL_NO_CIPHER_MATCH` is a local cipher configuration that fails before we
 * ever reach the provider. The `_ALERT_` infix is what separates "the peer
 * objected" from "our own TLS setup is wrong". Non-alert OpenSSL failures that
 * really are transport failures are enumerated below by name instead.
 *
 * `EPROTO` does not stand in for any of this: it is the errno, not the OpenSSL
 * code, and the two arrive separately.
 */
const OPENSSL_ALERT = /^ERR_SSL_[A-Z0-9]+_ALERT_[A-Z0-9_]+$/;

/**
 * The alerts that say the peer looked at *our* TLS credential and refused it.
 *
 * Receiving an alert proves the far end was reachable and objected — it does not
 * prove the objection was theirs to fix. `CERTIFICATE_REQUIRED` means we sent
 * none, `UNKNOWN_CA` and `BAD_CERTIFICATE` mean the one we sent was not
 * accepted, and `ACCESS_DENIED` is RFC 8446 §6.2's "a valid certificate was
 * received, but when access control was applied, the sender decided not to
 * proceed" — the mTLS way of saying this client is not on the list.
 * `UNKNOWN_PSK_IDENTITY` is the same refusal for a pre-shared key. Under this
 * file's own taxonomy those are the TLS spelling of `invalid_client`: nobody
 * typed anything wrong, every login fails, and waiting will not help. They take
 * the same `client_authentication_failed` slug.
 */
const CLIENT_CREDENTIAL_ALERT =
  /_ALERT_(BAD_CERTIFICATE|UNSUPPORTED_CERTIFICATE|CERTIFICATE_REVOKED|CERTIFICATE_EXPIRED|CERTIFICATE_UNKNOWN|UNKNOWN_CA|CERTIFICATE_REQUIRED|ACCESS_DENIED|UNKNOWN_PSK_IDENTITY)$/;

/**
 * The alerts that say the two ends could not agree on how to talk at all, and
 * that name our side's message as the thing they could not accept.
 *
 * `PROTOCOL_VERSION` is RFC 5246 §7.2.2's "the protocol version the client has
 * attempted to negotiate is recognized but not supported" and
 * `INSUFFICIENT_SECURITY` is that section's "the server requires ciphers more
 * secure than those supported by the client"; RFC 8446 §6.2 defines
 * `MISSING_EXTENSION` against a handshake message that omitted an extension it
 * was required to send and `UNSUPPORTED_EXTENSION` against one that carried an
 * extension it was forbidden to send. Each one quotes something we sent and says
 * what is wrong with it. The peer was reachable and objected to our terms rather
 * than to us; waiting will not change either side's configuration, so an
 * operator has to. They take `local_defect` rather than the credential slug
 * because nothing about our identity was refused — only our terms.
 */
const NEGOTIATION_ALERT =
  /_ALERT_(PROTOCOL_VERSION|INSUFFICIENT_SECURITY|MISSING_EXTENSION|UNSUPPORTED_EXTENSION)$/;

/**
 * The alerts that report an empty intersection rather than a fault, which is a
 * fourth thing and not a harder instance of the other three.
 *
 * RFC 5246 §7.2.2 defines alert 40, `HANDSHAKE_FAILURE`, as "unable to negotiate
 * an acceptable set of security parameters", and RFC 8446 §6.2 defines
 * `NO_APPLICATION_PROTOCOL` as a client advertising only protocols the server
 * does not support. Both name the outcome — no overlap — and neither says whose
 * set should have contained the other's. Unlike every member of
 * {@link NEGOTIATION_ALERT} they quote nothing of ours *and say what is wrong
 * with it*, and unlike {@link CLIENT_CREDENTIAL_ALERT} they refuse no credential
 * of ours. A provider node brought up with the wrong certificate chain, a
 * half-finished TLS rollout across their fleet, or a rollout that dropped the
 * protocol we offer emits exactly this and nothing else — before any HTTP exists
 * to carry a status. So does a cipher, curve or ALPN list of ours that their new
 * configuration no longer accepts.
 *
 * Two reviews of this file reached opposite conclusions from that same fact, one
 * calling the row a negotiation defect and one calling it a lost outage signal,
 * and both were right about their half. The row is not what is wrong; the
 * taxonomy was, because it offered only answers that name a party. `indeterminate`
 * with its own slug says what the alert says and stops there: the sign-in did not
 * happen, retrying later is the only move a person has, and which end has to
 * change is not in the evidence. An operator greps `tls_negotiation_failed` and
 * looks at both.
 *
 * A code this module does not recognise stays `defect`/`unrecognised_failure`
 * and does not come here. The distinction is deliberate: `indeterminate` is for
 * evidence we have read and that is silent by construction, while an
 * unrecognised code is evidence we have not read at all — which is this module
 * being behind, and an operator's move.
 */
const UNATTRIBUTED_ALERT = /_ALERT_(HANDSHAKE_FAILURE|NO_APPLICATION_PROTOCOL)$/;

function readProperty(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  try {
    // The cast is safe because the line above has already established that this
    // is a non-null object; indexing one with a string is always defined
    // behaviour, and the `try` is here because the *getter* may not be.
    return (value as Record<string, unknown>)[key];
  } catch {
    throw new UnreadableValue(key);
  }
}

function stringProperty(value: unknown, key: string): string | undefined {
  const read = readProperty(value, key);
  return typeof read === 'string' && read !== '' ? read : undefined;
}

function numberProperty(value: unknown, key: string): number | undefined {
  const read = readProperty(value, key);
  return typeof read === 'number' ? read : undefined;
}

function isTransportCode(code: string): boolean {
  return TRANSPORT_CODES.has(code) || OPENSSL_ALERT.test(code);
}

/** Walks `cause` for a transport code, since `fetch` buries it one or more levels down. */
function transportCodeOf(value: unknown, depth = 0): string | undefined {
  if (depth > 4 || typeof value !== 'object' || value === null) return undefined;
  const code = stringProperty(value, 'code');
  if (code !== undefined && isTransportCode(code)) return code;
  return transportCodeOf(readProperty(value, 'cause'), depth + 1);
}

/**
 * Reads the arm out of an OAuth error response, where the envelope code says
 * only that the provider answered in OAuth's error shape.
 *
 * An error value nobody here recognises is corroborated by the HTTP status
 * rather than guessed: a provider inventing a name for its own failure still
 * sends it under a 5xx, and everything else is ours to look at.
 */
function classifyOAuthErrorResponse(error: unknown): OidcFailure {
  const value = stringProperty(error, 'error');
  const known = value === undefined ? undefined : OAUTH_ERROR_VALUES.get(value);
  if (known !== undefined) return known;

  const status = numberProperty(error, 'status');
  if (status !== undefined && status >= 500) return UNAVAILABLE('provider_reported_outage');
  return DEFECT('unrecognised_failure');
}

/**
 * Classifies whatever `exchange` rejected with.
 *
 * Takes `unknown` on purpose: a `catch` binding is `unknown`, and the point of
 * this function is that the caller never has to narrow it itself. For the same
 * reason it cannot throw — a value whose property getter throws is a `defect`,
 * not an exception escaping the boundary that was supposed to contain one.
 *
 * The two ways of ending up there are kept apart. A value that would not be read
 * is `unreadable_failure`; anything this module itself got wrong is
 * `local_defect`, so a regression in here is not filed as someone else's hostile
 * input.
 */
export function classifyOidcFailure(error: unknown): OidcFailure {
  try {
    const transport = transportCodeOf(error);
    if (transport !== undefined) {
      if (CLIENT_CREDENTIAL_ALERT.test(transport)) return DEFECT('client_authentication_failed');
      if (NEGOTIATION_ALERT.test(transport)) return DEFECT('local_defect');
      if (UNATTRIBUTED_ALERT.test(transport)) return INDETERMINATE('tls_negotiation_failed');
      return UNAVAILABLE('provider_unreachable');
    }

    const code = stringProperty(error, 'code');
    if (code === undefined) return DEFECT('unrecognised_failure');
    if (OAUTH_ERROR_ENVELOPES.has(code)) return classifyOAuthErrorResponse(error);

    return CODE_TABLE.get(code) ?? DEFECT('unrecognised_failure');
  } catch (thrown) {
    return DEFECT(thrown instanceof UnreadableValue ? 'unreadable_failure' : 'local_defect');
  }
}
