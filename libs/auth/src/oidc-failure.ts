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
 * assigned by whoever argued last. See {@link PARTY_NEUTRAL_ALERTS}.
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
  // `OAUTH_PARSE_ERROR` is the third member of the "did not answer as itself"
  // row, and it was filed as `local_defect` until someone traced where it
  // actually comes from. The library's documentation covers JWS/JWE headers,
  // JSON bodies and request parameters — which reads local, and is why it was
  // put there — but on the path this classifier serves it is raised by
  // `getResponseJsonBody()` when the *provider's* token response will not parse.
  // A token endpoint answering 200 with `application/json` and a truncated body
  // arrives here, and calling that our own defect pages an operator to debug
  // code that did nothing wrong. The inputs this module is documented against
  // are the ones `exchange` is handed, and those come from the far end.
  //
  // The genuinely local half of the code's range is not lost: a parse failure
  // that has a transport cause under it never reaches this table at all, because
  // the walk runs first — see {@link PROVIDER_CONTROLLED_CAUSE}.
  ['OAUTH_PARSE_ERROR', UNAVAILABLE('provider_response_unusable')],
]);

/** Envelope codes that carry an RFC 6749 error value worth reading. */
const OAUTH_ERROR_ENVELOPES: ReadonlySet<string> = new Set([
  'OAUTH_RESPONSE_BODY_ERROR',
  'OAUTH_AUTHORIZATION_RESPONSE_ERROR',
]);

/**
 * The codes whose `cause` the provider fills in, which is the only reason a
 * top-level code is ever read before the transport walk.
 *
 * The walk exists because `fetch` buries the real failure one or more levels
 * down, so it has to descend — and descending is exactly what a provider can
 * exploit. `oauth4webapi` hangs the complete JSON error body on
 * `ResponseBodyError.cause`, the authorization response parameters on
 * `AuthorizationResponseError.cause`, and the parsed challenge on
 * `WWWAuthenticateChallengeError.cause`. For those three the top level is the
 * library's own word and the level below it is the provider's, so the top level
 * decides and the walk never runs.
 *
 * **Every other code is the other way round and must not be listed here.** Their
 * causes are the library's or the platform's, and they are frequently the only
 * place the real failure is recorded: `oauth4webapi` raises `OAUTH_PARSE_ERROR`
 * for a rejected `response.json()` and preserves the rejection as its `cause`,
 * so a provider that closes the socket mid-body arrives as
 * `OAUTH_PARSE_ERROR` wrapping `UND_ERR_SOCKET`. Reading the top level first
 * there would file a real outage as `local_defect` — the same evidence thrown
 * away, one layer out from the defect this ordering was written to fix.
 */
const PROVIDER_CONTROLLED_CAUSE: ReadonlySet<string> = new Set([
  ...OAUTH_ERROR_ENVELOPES,
  'OAUTH_WWW_AUTHENTICATE_CHALLENGE',
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
 * none of the three is evidence about the provider, and this walk descends
 * through `cause` while the tables above read only the top level, so listing
 * them would let a torn-down socket outrank an answer the provider really sent.
 * The timeouts below are the codes that do carry that evidence.
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
 * How OpenSSL spells a TLS alert — measured, because it does not spell them all
 * the same way and three rules here were written against spellings that never
 * occur.
 *
 * Node builds `error.code` from OpenSSL's reason string by uppercasing it and
 * turning spaces into underscores, so the shape of the code is the shape of the
 * reason table. Read out of the exact runtime this project ships — Node 24.18.1
 * with OpenSSL 3.5.7 — every alert reason in the binary falls into four
 * spellings, and only two of them look alike:
 *
 * | reason string | resulting code | alerts |
 * |---|---|---|
 * | `ssl/tls alert <name>` | `ERR_SSL_SSL/TLS_ALERT_<NAME>` | 11 |
 * | `tlsv1 alert <name>` | `ERR_SSL_TLSV1_ALERT_<NAME>` | 15 |
 * | `tlsv13 alert <name>` | `ERR_SSL_TLSV13_ALERT_<NAME>` | 2 |
 * | `tlsv1 <name>` | `ERR_SSL_TLSV1_<NAME>` | 5 |
 *
 * **The slash is real.** A provoked handshake failure on that runtime rejects
 * with `code: 'ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE'`, and the earlier
 * `[A-Z0-9]+` protocol token could not match it. That single spelling carries
 * `handshake_failure`, `illegal_parameter`, `unexpected_message` and every
 * certificate alert, so most rows below were dead before this was measured. The
 * last row is the other half: five alerts whose reason string omits `alert`
 * altogether, which is how `unrecognized_name` and `unsupported_extension` were
 * each found misfiled, one review apart, before the third showed it was a class.
 *
 * So **no rule in this file matches a code**. One reader turns a code into an
 * alert name, every taxonomy row is a set of names, and the next spelling
 * OpenSSL invents is one change here instead of four silent holes.
 *
 * **`ERR_SSL_` on its own still would not do**, which is the `UND_ERR_` prefix
 * mistake in a different coat: it is OpenSSL's whole namespace, and
 * `ERR_SSL_NO_CIPHER_MATCH` is a local cipher configuration that fails before we
 * ever reach the provider. Being an alert is what separates "the peer objected"
 * from "our own TLS setup is wrong". Non-alert OpenSSL failures that really are
 * transport failures are enumerated by name in {@link TRANSPORT_CODES} instead.
 *
 * `EPROTO` does not stand in for any of this: it is the errno, not the OpenSSL
 * code, and the two arrive separately.
 */
const OPENSSL_ALERT_CODE = /^ERR_SSL_[A-Z0-9/]+_ALERT_([A-Z0-9_]+)$/;

/**
 * The alerts OpenSSL 3.5.7 reports without the word `alert` in its reason
 * string, which is why they have to be listed rather than matched by shape.
 *
 * All five are the RFC 6066 extension alerts (110 and 111–114). Nothing about
 * them is less of an alert; OpenSSL simply never regularised those five reason
 * strings. Listing them closes the class, and a sixth added later lands in
 * `unrecognised_failure` — this module being behind, which is an operator's
 * move — rather than being read as something it is not.
 */
const INFIXLESS_ALERT_NAMES: ReadonlySet<string> = new Set([
  'UNRECOGNIZED_NAME',
  'UNSUPPORTED_EXTENSION',
  'CERTIFICATE_UNOBTAINABLE',
  'BAD_CERTIFICATE_STATUS_RESPONSE',
  'BAD_CERTIFICATE_HASH_VALUE',
]);

const OPENSSL_BARE_CODE = /^ERR_SSL_[A-Z0-9/]+_([A-Z0-9_]+)$/;

/** The alert a code names, in either spelling, or `undefined` if it names none. */
function alertNameOf(code: string): string | undefined {
  const alert = OPENSSL_ALERT_CODE.exec(code);
  if (alert !== null) return alert[1];

  const bare = OPENSSL_BARE_CODE.exec(code);
  if (bare !== null && INFIXLESS_ALERT_NAMES.has(bare[1])) return bare[1];
  return undefined;
}

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
 *
 * The last two are RFC 6066 §5's alerts about a credential of ours that the peer
 * was handed a *pointer* to rather than the credential itself:
 * `certificate_unobtainable` is the peer failing to fetch our certificate from
 * the URL we supplied, and `bad_certificate_hash_value` is that certificate not
 * matching the hash we supplied with it. Both are about a credential we offered,
 * neither can arrive unless a deployment enabled an extension this project does
 * not use, and an operator rather than time has to act on either.
 *
 * **`bad_certificate_status_response` is deliberately not here**, though it is
 * the third RFC 6066 alert and reads like the third member. RFC 8446 §6.2 names
 * its sender as the *client* rejecting a server's OCSP response, and this code
 * is the client — so receiving alert 113 is the far end failing in a role it
 * should not have taken, and nothing in it says a credential of ours was
 * refused. Filing it here would page an operator to check client credentials
 * that were never in question, which is the exact misfiling this module exists
 * to stop. It stays a recognised alert and takes the open-ended answer every
 * other recognised alert takes: evidence about the peer, so `unavailable`.
 */
const CLIENT_CREDENTIAL_ALERTS: ReadonlySet<string> = new Set([
  'BAD_CERTIFICATE',
  'UNSUPPORTED_CERTIFICATE',
  'CERTIFICATE_REVOKED',
  'CERTIFICATE_EXPIRED',
  'CERTIFICATE_UNKNOWN',
  'UNKNOWN_CA',
  'CERTIFICATE_REQUIRED',
  'ACCESS_DENIED',
  'UNKNOWN_PSK_IDENTITY',
  'CERTIFICATE_UNOBTAINABLE',
  'BAD_CERTIFICATE_HASH_VALUE',
]);

/**
 * The alerts that say the message we sent broke the protocol.
 *
 * This is one half of the line the two arms are drawn on, and the line is
 * **protocol violation versus capability mismatch**, not "does the alert mention
 * something of ours". Every alert here is RFC 8446 §6.2 asserting that the
 * received handshake was malformed against the specification itself:
 * `ILLEGAL_PARAMETER` is "a field in the handshake was incorrect or inconsistent
 * with other fields", `UNEXPECTED_MESSAGE` is a message that had no business
 * being sent at that point, and `MISSING_EXTENSION` and `UNSUPPORTED_EXTENSION`
 * are an extension that had to be present or must not have been. A conforming
 * peer cannot provoke any of them by changing its own configuration, which is
 * what makes them ours and not a shared outcome.
 *
 * **`DECODE_ERROR` is deliberately absent, though it reads like the clearest
 * member of the list.** RFC 8446 §6.2 attaches an exception to it that the
 * others do not carry: it "should never be observed in communication between
 * proper implementations, except when messages were corrupted in the network".
 * A corrupted message is neither end being wrong, so filing it here would page
 * an operator for a failure nobody caused. See {@link PARTY_NEUTRAL_ALERTS}.
 *
 * They take `local_defect` rather than the credential slug because nothing about
 * our identity was refused, and an operator rather than time has to act.
 */
const LOCAL_PROTOCOL_VIOLATION_ALERTS: ReadonlySet<string> = new Set([
  'ILLEGAL_PARAMETER',
  'UNEXPECTED_MESSAGE',
  'MISSING_EXTENSION',
  'UNSUPPORTED_EXTENSION',
]);

/**
 * The alerts that report an empty intersection between two conforming ends,
 * which is a fourth thing and not a harder instance of the other three.
 *
 * This is the other half of the line. Nothing here says either side broke the
 * protocol; each says only that what we offer and what they accept do not meet.
 * RFC 5246 §7.2.2 defines `HANDSHAKE_FAILURE` as "unable to negotiate an
 * acceptable set of security parameters" and `PROTOCOL_VERSION` as a version
 * that is recognised but not supported; `INSUFFICIENT_SECURITY` is that
 * section's server requiring ciphers more secure than the client's, which RFC
 * 8446 §6.2 restates as no overlap between the two parameter sets; and
 * `NO_APPLICATION_PROTOCOL` is a client advertising only protocols the server
 * does not support. Every one of them is emitted, unchanged, by a provider
 * rollout that raised or narrowed its own requirements while we changed nothing
 * — and by a list of ours that was always too narrow. The alert does not say
 * which happened, so neither does this module.
 *
 * A provider node brought up with the wrong certificate chain and a
 * half-finished TLS rollout across their fleet reach here too, before any HTTP
 * exists to carry a status.
 *
 * Two reviews of this file reached opposite conclusions about `HANDSHAKE_FAILURE`
 * from that same fact, one calling it a negotiation defect and one calling it a
 * lost outage signal, and both were right about their half. The row was not what
 * was wrong; the taxonomy was, because it offered only answers that name a
 * party. `indeterminate` with its own slug says what the alert says and stops
 * there: the sign-in did not happen, retrying later is the only move a person
 * has, and which end has to change is not in the evidence. An operator greps
 * `tls_negotiation_failed` and looks at both.
 *
 * A code this module does not recognise stays `defect`/`unrecognised_failure`
 * and does not come here. The distinction is deliberate: `indeterminate` is for
 * evidence we have read and that is silent by construction, while an
 * unrecognised code is evidence we have not read at all — which is this module
 * being behind, and an operator's move.
 *
 * Two more alerts name an outcome without naming a party, and they take the
 * same answer rather than arms of their own.
 *
 * RFC 6066 §3's `unrecognized_name` says the server has no configuration under
 * the name our `server_name` extension asked for. That is equally an issuer
 * hostname of ours that was wrong and a provider rollout that stopped serving
 * that hostname, so it sits exactly where the mismatches do.
 *
 * `DECODE_ERROR` is the one alert RFC 8446 §6.2 excuses outright: it "should
 * never be observed in communication between proper implementations, except when
 * messages were corrupted in the network". Receiving it proves the provider was
 * reached and that something between us damaged what it read, so neither
 * `local_defect` nor `provider_unreachable` is true — the same unresolved
 * responsibility, and not a fifth kind.
 */
const PARTY_NEUTRAL_ALERTS: ReadonlySet<string> = new Set([
  'HANDSHAKE_FAILURE',
  'PROTOCOL_VERSION',
  'INSUFFICIENT_SECURITY',
  'NO_APPLICATION_PROTOCOL',
  'UNRECOGNIZED_NAME',
  'DECODE_ERROR',
]);

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
  return TRANSPORT_CODES.has(code) || alertNameOf(code) !== undefined;
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
 *
 * **The order of the three lookups is load-bearing, and it turns on one
 * question: whose `cause` is it?**
 *
 * A code in {@link PROVIDER_CONTROLLED_CAUSE} is read first and the walk never
 * runs, because the level below it belongs to the provider. `oauth4webapi` hangs
 * the complete JSON body on `ResponseBodyError.cause`, so a perfectly ordinary
 * token-endpoint refusal answering
 * `{"error":"invalid_grant","code":"ERR_SSL_TLSV1_UNRECOGNIZED_NAME"}` would,
 * walked first, be read as a TLS failure and answered `indeterminate` instead of
 * `refused` — a field the provider controls outranking an envelope we trust,
 * which is provider input steering our own classification.
 *
 * Every other code is read *after* the walk, because its `cause` is the
 * library's or the platform's and is often the only place the real failure is
 * recorded. `OAUTH_PARSE_ERROR` wrapping `UND_ERR_SOCKET` is a provider that
 * closed the socket mid-body; reading the table first would answer
 * `local_defect` and lose the outage — the same mistake as the one above, made
 * one layer out. Trusting the top level everywhere is not the fix; trusting it
 * exactly where the layer below is untrusted is.
 */
export function classifyOidcFailure(error: unknown): OidcFailure {
  try {
    const code = stringProperty(error, 'code');
    if (code !== undefined && PROVIDER_CONTROLLED_CAUSE.has(code)) {
      if (OAUTH_ERROR_ENVELOPES.has(code)) return classifyOAuthErrorResponse(error);

      const known = CODE_TABLE.get(code);
      if (known !== undefined) return known;
    }

    const transport = transportCodeOf(error);
    if (transport !== undefined) {
      const alert = alertNameOf(transport);
      if (alert !== undefined) {
        if (CLIENT_CREDENTIAL_ALERTS.has(alert)) return DEFECT('client_authentication_failed');
        if (LOCAL_PROTOCOL_VIOLATION_ALERTS.has(alert)) return DEFECT('local_defect');
        if (PARTY_NEUTRAL_ALERTS.has(alert)) return INDETERMINATE('tls_negotiation_failed');
      }
      return UNAVAILABLE('provider_unreachable');
    }

    if (code !== undefined) {
      const known = CODE_TABLE.get(code);
      if (known !== undefined) return known;
    }

    return DEFECT('unrecognised_failure');
  } catch (thrown) {
    return DEFECT(thrown instanceof UnreadableValue ? 'unreadable_failure' : 'local_defect');
  }
}
