import { describe, expect, it } from 'bun:test';

import { classifyOidcFailure } from './oidc-failure';

/**
 * Every case here builds a plain object with a `code`, never an instance of a
 * library error. That is the contract: if this file had to import a class from
 * `openid-client` to write a case, the classifier would be reading the
 * dependency's internals and the whole point of owning the union would be gone.
 *
 * Every case asserts `reason` as well as `kind`, because `reason` is what the
 * log line carries and a slug that silently changes is an alert that silently
 * stops matching.
 */
describe('classifyOidcFailure', () => {
  describe('a well-formed OAuth error response, read by its error value', () => {
    // The finding this rework exists for: the token endpoint answering in
    // OAuth's error shape says nothing on its own about whose fault it was.
    const bodyError = (error: string, status = 400) => ({
      code: 'OAUTH_RESPONSE_BODY_ERROR',
      error,
      status,
    });

    it('calls a spent or wrong code a refusal', () => {
      expect(classifyOidcFailure(bodyError('invalid_grant'))).toEqual({
        kind: 'refused',
        reason: 'grant_refused',
      });
    });

    it('calls every interaction the person did not complete a refusal', () => {
      // One case per remaining refusal row, so the table's claim that each row
      // is proven is true of all of them and not only the ones worth a sentence.
      for (const value of [
        'access_denied',
        'login_required',
        'consent_required',
        'interaction_required',
        'account_selection_required',
      ]) {
        expect(classifyOidcFailure(bodyError(value))).toEqual({
          kind: 'refused',
          reason: 'grant_refused',
        });
      }
    });

    it('calls a failing provider unavailable even though it answered in OAuth shape', () => {
      // Without this row the outage this task exists to separate is answered
      // 401, which is the status quo with more ceremony.
      //
      // Every case here carries a 4xx on purpose. RFC 6749 §5.2 defaults a token
      // error response to 400, and a 5xx would be answered by the corroboration
      // fallback whether or not the row existed — so asserting these under a 500
      // would prove the fallback works and say nothing at all about the table.
      expect(classifyOidcFailure(bodyError('server_error', 400))).toEqual({
        kind: 'unavailable',
        reason: 'provider_reported_outage',
      });
      expect(classifyOidcFailure(bodyError('temporarily_unavailable', 400))).toEqual({
        kind: 'unavailable',
        reason: 'provider_reported_outage',
      });
    });

    it('calls our own rejected client credentials a defect, not a refusal', () => {
      // Nobody typed anything wrong: every login fails until an operator acts.
      expect(classifyOidcFailure(bodyError('invalid_client', 401))).toEqual({
        kind: 'defect',
        reason: 'client_authentication_failed',
      });
      expect(classifyOidcFailure(bodyError('unauthorized_client', 400))).toEqual({
        kind: 'defect',
        reason: 'client_authentication_failed',
      });
    });

    it('calls a request the provider would not accept a defect', () => {
      for (const value of [
        'invalid_request',
        'invalid_scope',
        'unsupported_grant_type',
        'unsupported_response_type',
      ]) {
        expect(classifyOidcFailure(bodyError(value))).toEqual({
          kind: 'defect',
          reason: 'request_rejected',
        });
      }
    });

    it('takes an unrecognised error value under a 5xx as the outage it corroborates', () => {
      expect(classifyOidcFailure(bodyError('provider_specific_meltdown', 502))).toEqual({
        kind: 'unavailable',
        reason: 'provider_reported_outage',
      });
    });

    it('does not guess an unrecognised error value under a 4xx', () => {
      expect(classifyOidcFailure(bodyError('provider_specific_thing', 400))).toEqual({
        kind: 'defect',
        reason: 'unrecognised_failure',
      });
    });

    it('does not guess when the envelope carries no error value at all', () => {
      expect(classifyOidcFailure({ code: 'OAUTH_RESPONSE_BODY_ERROR' })).toEqual({
        kind: 'defect',
        reason: 'unrecognised_failure',
      });
    });

    it('reads the authorization response the same way', () => {
      // Same error values, different endpoint: a provider failing mid-outage can
      // redirect back with `temporarily_unavailable` just as it can answer with it.
      expect(
        classifyOidcFailure({ code: 'OAUTH_AUTHORIZATION_RESPONSE_ERROR', error: 'access_denied' }),
      ).toEqual({ kind: 'refused', reason: 'grant_refused' });
      expect(
        classifyOidcFailure({
          code: 'OAUTH_AUTHORIZATION_RESPONSE_ERROR',
          error: 'temporarily_unavailable',
        }),
      ).toEqual({ kind: 'unavailable', reason: 'provider_reported_outage' });
    });
  });

  describe('codes that mean the same thing whatever the body says', () => {
    it('calls an ID token whose claims do not check out a refusal', () => {
      expect(classifyOidcFailure({ code: 'OAUTH_JWT_TIMESTAMP_CHECK_FAILED' })).toEqual({
        kind: 'refused',
        reason: 'claims_refused',
      });
      expect(classifyOidcFailure({ code: 'OAUTH_JWT_CLAIM_COMPARISON_FAILED' })).toEqual({
        kind: 'refused',
        reason: 'claims_refused',
      });
    });

    it('calls a response that is not the provider speaking unavailable', () => {
      // A gateway serving an HTML error page or a bare 502 during an outage.
      for (const code of ['OAUTH_RESPONSE_IS_NOT_JSON', 'OAUTH_RESPONSE_IS_NOT_CONFORM']) {
        expect(classifyOidcFailure({ code })).toEqual({
          kind: 'unavailable',
          reason: 'provider_response_unusable',
        });
      }
    });

    it('does not call a response that failed validation an outage', () => {
      // `OAUTH_INVALID_RESPONSE` reads like it belongs with the two above and
      // does not: the library also raises it for a missing or unexpected
      // `state`, `iss` or `code`, which is a callback that was malformed or
      // tampered with, not a provider that is down.
      expect(classifyOidcFailure({ code: 'OAUTH_INVALID_RESPONSE' })).toEqual({
        kind: 'defect',
        reason: 'unrecognised_failure',
      });
    });

    it('calls a rejected client challenge a defect', () => {
      expect(classifyOidcFailure({ code: 'OAUTH_WWW_AUTHENTICATE_CHALLENGE' })).toEqual({
        kind: 'defect',
        reason: 'client_authentication_failed',
      });
    });

    it('calls our own malformed request a defect', () => {
      expect(classifyOidcFailure({ code: 'OAUTH_INVALID_REQUEST' })).toEqual({
        kind: 'defect',
        reason: 'request_rejected',
      });
      expect(classifyOidcFailure({ code: 'OAUTH_UNSUPPORTED_OPERATION' })).toEqual({
        kind: 'defect',
        reason: 'local_defect',
      });
      // `OAUTH_PARSE_ERROR` used to be asserted here on the strength of the
      // library's documentation. On the path `exchange` takes it is the
      // provider's response that will not parse, so it is not ours — see the
      // case that traces where it comes from.
    });

    it('calls a code it has never seen a defect', () => {
      // The guard against a future library code being read as something it is
      // not: an unrecognised code must not fall into `refused`.
      expect(classifyOidcFailure({ code: 'OAUTH_SOMETHING_ADDED_IN_A_LATER_VERSION' })).toEqual({
        kind: 'defect',
        reason: 'unrecognised_failure',
      });
    });
  });

  describe('transport failures, which arrive with no OAuth code', () => {
    it('calls an unresolvable issuer unavailable, not a refusal', () => {
      // What a real DNS failure looks like by the time it leaves `fetch`: a bare
      // TypeError with the only useful fact one level down in `cause`.
      const failure = classifyOidcFailure(
        new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }),
      );

      expect(failure).toEqual({ kind: 'unavailable', reason: 'provider_unreachable' });
    });

    it('calls a refused connection and an expired certificate unavailable', () => {
      for (const code of [
        'ECONNREFUSED',
        'EHOSTDOWN',
        'CERT_HAS_EXPIRED',
        'ERR_TLS_CERT_ALTNAME_INVALID',
      ]) {
        expect(classifyOidcFailure(new TypeError('fetch failed', { cause: { code } }))).toEqual({
          kind: 'unavailable',
          reason: 'provider_unreachable',
        });
      }
    });

    it('calls an alert the peer sent unavailable, including one it has never heard of', () => {
      // TLS alert names are an open family, so this row is matched by shape, not
      // by a closed list. The second case is the point: an alert added tomorrow
      // is still an alert, because an alert is by definition something the far
      // end sent us, and an unrecognised one is evidence about the far end.
      // `INTERNAL_ERROR` is the alert that says so outright.
      for (const code of [
        'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR',
        'ERR_SSL_TLSV1_ALERT_SOMETHING_OPENSSL_ADDS_LATER',
        // Not alerts, but still about what came back over the wire — one case
        // per enumerated member, so removing any of them turns this red.
        'ERR_SSL_WRONG_VERSION_NUMBER',
        'ERR_SSL_UNSUPPORTED_PROTOCOL',
        'ERR_SSL_PACKET_LENGTH_TOO_LONG',
      ]) {
        expect(classifyOidcFailure(new TypeError('fetch failed', { cause: { code } }))).toEqual({
          kind: 'unavailable',
          reason: 'provider_unreachable',
        });
      }
    });

    it('calls an alert about our own TLS credential a defect, not an outage', () => {
      // Receiving an alert proves the far end was reachable and objected. It
      // does not prove the objection was theirs to fix: these three say the
      // certificate we presented was missing or refused, which is the TLS
      // spelling of `invalid_client` and fails every login until an operator
      // acts. Waiting, the `unavailable` move, would never clear them.
      // One case per member of the rule. `CERTIFICATE_EXPIRED` is the one worth
      // reading twice: as a TLS alert it means the peer rejected the
      // certificate *we* sent, while the errno `CERT_HAS_EXPIRED` above means
      // *theirs* had expired and is `unavailable`. Same words, opposite arms.
      // Every code here is in the spelling OpenSSL 3.5.7 really emits, read out
      // of the shipped Node binary's reason table: the five certificate alerts
      // are `ssl/tls alert …` and reach us with a literal slash in the code.
      for (const code of [
        'ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED',
        'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA',
        'ERR_SSL_SSL/TLS_ALERT_BAD_CERTIFICATE',
        'ERR_SSL_SSL/TLS_ALERT_UNSUPPORTED_CERTIFICATE',
        'ERR_SSL_SSL/TLS_ALERT_CERTIFICATE_REVOKED',
        'ERR_SSL_SSL/TLS_ALERT_CERTIFICATE_EXPIRED',
        'ERR_SSL_SSL/TLS_ALERT_CERTIFICATE_UNKNOWN',
        // RFC 8446 §6.2: a valid certificate arrived and access control refused
        // it anyway. Every login fails until this client is allowed.
        'ERR_SSL_TLSV1_ALERT_ACCESS_DENIED',
        // The same refusal aimed at a pre-shared key rather than a certificate.
        'ERR_SSL_TLSV1_ALERT_UNKNOWN_PSK_IDENTITY',
        // RFC 6066 §5's two alerts about a credential of ours the peer was handed
        // a pointer to. Both are spelled with no `alert` in the reason string,
        // so they arrive as `ERR_SSL_TLSV1_<NAME>`. The third RFC 6066
        // certificate alert, `bad_certificate_status_response`, is deliberately
        // not here — see the case below.
        'ERR_SSL_TLSV1_CERTIFICATE_UNOBTAINABLE',
        'ERR_SSL_TLSV1_BAD_CERTIFICATE_HASH_VALUE',
        // The spelling the rules were written against before this was measured.
        // Kept so a future OpenSSL that regularises the reason table does not
        // silently drop the row.
        'ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE',
      ]) {
        expect(classifyOidcFailure(new TypeError('fetch failed', { cause: { code } }))).toEqual({
          kind: 'defect',
          reason: 'client_authentication_failed',
        });
      }
    });

    it('calls an alert that says our message broke the protocol a defect, not an outage', () => {
      // The line is protocol violation versus capability mismatch. Each of these
      // is RFC 8446 §6.2 asserting the handshake it received was malformed
      // against the specification: a field out of range or inconsistent, a
      // message that had no business being sent, an extension that had to be
      // there or must not have been. `DECODE_ERROR` is not among them, because
      // §6.2 excuses it for messages corrupted in the network. A
      // conforming peer cannot provoke any of them by changing its own
      // configuration, which is what makes them ours — and what keeps them out
      // of the `indeterminate` arm below. One case per member of the rule.
      for (const code of [
        'ERR_SSL_SSL/TLS_ALERT_ILLEGAL_PARAMETER',
        'ERR_SSL_SSL/TLS_ALERT_UNEXPECTED_MESSAGE',
        'ERR_SSL_TLSV13_ALERT_MISSING_EXTENSION',
        // `unsupported_extension` is spelled with no `alert` in the reason
        // string, so this is the code Node really produces for alert 110.
        'ERR_SSL_TLSV1_UNSUPPORTED_EXTENSION',
        // Both spellings, so regularising the reason table cannot drop the row.
        'ERR_SSL_TLSV1_ALERT_ILLEGAL_PARAMETER',
        'ERR_SSL_TLSV1_ALERT_UNSUPPORTED_EXTENSION',
      ]) {
        expect(classifyOidcFailure(new TypeError('fetch failed', { cause: { code } }))).toEqual({
          kind: 'defect',
          reason: 'local_defect',
        });
      }
    });

    it('calls an alert that reports no overlap indeterminate, because it names no party', () => {
      // The other half of the line: none of these says either side broke the
      // protocol, only that what we offer and what they accept do not meet.
      // Alert 40 is "unable to negotiate an acceptable set of security
      // parameters", `PROTOCOL_VERSION` is a version recognised but not
      // supported, `INSUFFICIENT_SECURITY` is no overlap between the two
      // parameter sets, `NO_APPLICATION_PROTOCOL` is no overlap between two ALPN
      // lists. Every one is emitted unchanged by a provider rollout that raised
      // or narrowed its own requirements while we changed nothing, and by a list
      // of ours that was always too narrow. One case per member of the rule,
      // plus two extra prefixes for alert 40 because the rule is written against
      // the alert and not against the OpenSSL family.
      for (const code of [
        // The spelling a provoked handshake failure on this project's runtime
        // (Node 24.18.1, OpenSSL 3.5.7) really rejects with, slash and all.
        'ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE',
        'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE',
        'ERR_SSL_TLSV1_ALERT_HANDSHAKE_FAILURE',
        'ERR_SSL_TLSV13_ALERT_HANDSHAKE_FAILURE',
        'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION',
        'ERR_SSL_TLSV1_ALERT_INSUFFICIENT_SECURITY',
        'ERR_SSL_TLSV1_ALERT_NO_APPLICATION_PROTOCOL',
        // RFC 6066 §3's `unrecognized_name`, in the spelling OpenSSL actually
        // emits. Its reason string is `SSL_R_TLSV1_UNRECOGNIZED_NAME`, with no
        // `_ALERT_` infix, so a rule written against the alert shape would never
        // see the code Node really produces. Both spellings are asserted.
        'ERR_SSL_TLSV1_UNRECOGNIZED_NAME',
        'ERR_SSL_TLSV1_ALERT_UNRECOGNIZED_NAME',
        // Receiving `DECODE_ERROR` proves the provider was reached and that
        // something between us damaged what it read. RFC 8446 §6.2 excuses it
        // for exactly that, so neither end is established and it takes the same
        // answer rather than a fifth one.
        'ERR_SSL_TLSV1_ALERT_DECODE_ERROR',
      ]) {
        expect(classifyOidcFailure(new TypeError('fetch failed', { cause: { code } }))).toEqual({
          kind: 'indeterminate',
          reason: 'tls_negotiation_failed',
        });
      }
    });

    it('keeps the indeterminate arm out of both answers it refuses to give', () => {
      // The two findings this arm settles, each written as the assertion that
      // would have caught the other's fix. Calling it `unavailable` tells a
      // dashboard a provider is down on evidence that does not say so; calling
      // it `defect` throws away the outage signal when the far end really is the
      // broken one. It is allowed to be neither, and the slug carries the rest.
      const failure = classifyOidcFailure(
        new TypeError('fetch failed', {
          cause: { code: 'ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE' },
        }),
      );

      expect(failure.kind).not.toBe('unavailable');
      expect(failure.kind).not.toBe('defect');
      expect(failure.reason).not.toBe('provider_unreachable');
      expect(failure.reason).not.toBe('local_defect');
    });

    it('does not call our own TLS configuration an outage', () => {
      // `ERR_SSL_` is OpenSSL's whole namespace, not the alert family: a cipher
      // list that matches nothing fails before the provider is ever contacted,
      // and calling that an outage is the `UND_ERR_` mistake in a different coat.
      for (const code of ['ERR_SSL_NO_CIPHER_MATCH', 'ERR_SSL_NO_SHARED_CIPHER']) {
        expect(classifyOidcFailure(new TypeError('fetch failed', { cause: { code } }))).toEqual({
          kind: 'defect',
          reason: 'unrecognised_failure',
        });
      }
    });

    it('does not call our own dispatcher teardown an outage', () => {
      // These three say something about this process, not about the provider,
      // and the transport walk is the one lookup that descends through `cause` —
      // so listing them would let a socket we tore down outrank an answer the
      // provider really sent.
      for (const code of ['UND_ERR_CLOSED', 'UND_ERR_DESTROYED', 'UND_ERR_ABORTED']) {
        expect(classifyOidcFailure(new TypeError('fetch failed', { cause: { code } }))).toEqual({
          kind: 'defect',
          reason: 'unrecognised_failure',
        });
      }
    });

    it('finds a transport failure buried more than one cause deep', () => {
      // A failed discovery, which `exchange` awaits before it touches the token
      // endpoint, arrives wrapped like this.
      expect(
        classifyOidcFailure({
          message: 'discovery failed',
          cause: new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }),
        }),
      ).toEqual({ kind: 'unavailable', reason: 'provider_unreachable' });
    });

    it('does not read every undici code as an outage', () => {
      // The reason the transport list is enumerated and not `UND_ERR_`-prefixed:
      // these three are our own programming errors wearing the same prefix.
      for (const code of [
        'UND_ERR_INVALID_ARG',
        'UND_ERR_INVALID_RETURN_VALUE',
        'UND_ERR_NOT_SUPPORTED',
      ]) {
        expect(classifyOidcFailure(new TypeError('fetch failed', { cause: { code } }))).toEqual({
          kind: 'defect',
          reason: 'unrecognised_failure',
        });
      }
    });

    it('stops walking the cause chain rather than following it forever', () => {
      let deep: unknown = { code: 'ENOTFOUND' };
      for (let i = 0; i < 8; i += 1) deep = { cause: deep };

      expect(classifyOidcFailure(deep)).toEqual({
        kind: 'defect',
        reason: 'unrecognised_failure',
      });
    });
  });

  describe('a field the provider controls never outranks an envelope we trust', () => {
    it('reads the OAuth envelope before walking the body hung off its cause', () => {
      // `oauth4webapi` puts the provider's complete JSON body on
      // `ResponseBodyError.cause`, and a token endpoint may put anything in it.
      // Walking `cause` first read this ordinary `invalid_grant` refusal as a
      // TLS failure and answered `indeterminate`: a provider steering our own
      // classification, which is worse than a misfiled row. The envelope is a
      // string the library set and this project trusts, so it decides first.
      const failure = classifyOidcFailure({
        code: 'OAUTH_RESPONSE_BODY_ERROR',
        error: 'invalid_grant',
        status: 400,
        cause: { error: 'invalid_grant', code: 'ERR_SSL_TLSV1_UNRECOGNIZED_NAME' },
      });

      expect(failure).toEqual({ kind: 'refused', reason: 'grant_refused' });
    });

    it('will not let a provider body forge an outage either', () => {
      // The same defect aimed the other way: a refusal dressed as an unreachable
      // provider would take an operator to a dashboard during an ordinary
      // password typo, and a 5xx corroboration the provider never sent.
      const failure = classifyOidcFailure({
        code: 'OAUTH_RESPONSE_BODY_ERROR',
        error: 'access_denied',
        status: 400,
        cause: { code: 'ENOTFOUND' },
      });

      expect(failure).toEqual({ kind: 'refused', reason: 'grant_refused' });
    });

    it('does not let a library code we trust bury the outage recorded beneath it', () => {
      // The other half of the ordering, and the half that is easy to break while
      // fixing the first. `oauth4webapi` raises `OAUTH_PARSE_ERROR` when
      // `response.json()` rejects and keeps the rejection as its `cause`, so a
      // provider that closes the socket mid-body arrives exactly like this.
      // Reading the code table before the walk answers `local_defect` and files
      // a real outage as our own bug — the same evidence thrown away, one layer
      // out from the defect the ordering above was written to fix. Only a code
      // whose `cause` the provider fills in may outrank the walk.
      const failure = classifyOidcFailure({
        code: 'OAUTH_PARSE_ERROR',
        cause: new TypeError('terminated', { cause: { code: 'UND_ERR_SOCKET' } }),
      });

      expect(failure).toEqual({ kind: 'unavailable', reason: 'provider_unreachable' });
    });

    it('still answers from the code table when nothing beneath it is a transport failure', () => {
      // The walk running first must not cost the table its rows.
      expect(classifyOidcFailure({ code: 'OAUTH_PARSE_ERROR' })).toEqual({
        kind: 'unavailable',
        reason: 'provider_response_unusable',
      });
      expect(classifyOidcFailure({ code: 'OAUTH_RESPONSE_IS_NOT_JSON' })).toEqual({
        kind: 'unavailable',
        reason: 'provider_response_unusable',
      });
      // And a challenge is provider-controlled, so it keeps deciding first.
      expect(
        classifyOidcFailure({
          code: 'OAUTH_WWW_AUTHENTICATE_CHALLENGE',
          cause: [{ scheme: 'bearer', parameters: { code: 'ENOTFOUND' } }],
        }),
      ).toEqual({ kind: 'defect', reason: 'client_authentication_failed' });
    });

    it('does not call a provider body that will not parse our own defect', () => {
      // The mirror of the case above, and the reason `OAUTH_PARSE_ERROR` is not
      // a local defect on this path. A token endpoint answering 200 with
      // `application/json` and a truncated body reaches `exchange` like this,
      // through the library's own `getResponseJsonBody()`: no transport failure
      // anywhere beneath it, so the walk finds nothing and the table decides.
      // The provider supplied the unusable response; paging an operator to debug
      // code that did nothing wrong is the misfiling, aimed at ourselves.
      const failure = classifyOidcFailure({
        code: 'OAUTH_PARSE_ERROR',
        cause: {
          code: 'OAUTH_PARSE_ERROR',
          cause: new SyntaxError('Unexpected end of JSON input'),
        },
      });

      expect(failure).toEqual({ kind: 'unavailable', reason: 'provider_response_unusable' });
      expect(failure.reason).not.toBe('local_defect');
    });

    it('still finds a transport failure when the top-level code is not one we own', () => {
      // The ordering must not disable the walk. A bare `fetch` TypeError has no
      // code of its own, and a code this module does not recognise is not
      // evidence either — both still descend.
      expect(
        classifyOidcFailure(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })),
      ).toEqual({ kind: 'unavailable', reason: 'provider_unreachable' });

      expect(
        classifyOidcFailure({ code: 'SOMETHING_UNKNOWN', cause: { code: 'ENOTFOUND' } }),
      ).toEqual({ kind: 'unavailable', reason: 'provider_unreachable' });
    });
  });

  describe('every alert is matched in the spelling OpenSSL really emits', () => {
    // Measured, not assumed: Node 24.18.1 ships OpenSSL 3.5.7, whose reason
    // table spells alerts four ways — `ssl/tls alert <name>`, `tlsv1 alert
    // <name>`, `tlsv13 alert <name>` and, for five of them, `tlsv1 <name>` with
    // no `alert` at all. A provoked handshake failure on that runtime rejects
    // with a literal slash in `code`. Every rule in the module used to require a
    // single alphanumeric protocol token and an `_ALERT_` infix, so the whole
    // `ssl/tls` family and all five bare alerts were invisible: they reached
    // `unrecognised_failure` and an operator was paged for a provider outage.
    it('recognises the slash family as alerts at all', () => {
      for (const code of [
        'ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC',
        'ERR_SSL_SSL/TLS_ALERT_DECOMPRESSION_FAILURE',
        'ERR_SSL_SSL/TLS_ALERT_NO_CERTIFICATE',
      ]) {
        // Not in any named arm, so the open-ended answer is the right one — but
        // it has to be reached as an alert, not fall out as unrecognised.
        expect(classifyOidcFailure(new TypeError('fetch failed', { cause: { code } }))).toEqual({
          kind: 'unavailable',
          reason: 'provider_unreachable',
        });
      }
    });

    it('does not read a server OCSP alert as our credential being refused', () => {
      // RFC 8446 §6.2 names the sender of `bad_certificate_status_response` as
      // the client rejecting a server's OCSP response, and this code is the
      // client. Receiving alert 113 is therefore the far end failing in a role
      // it should not have taken, and it says nothing about a credential of
      // ours. Filing it with the credential alerts would page an operator to
      // check client credentials that were never in question — the misfiling
      // this module exists to stop. It is still a recognised alert, so it takes
      // the open-ended answer: evidence about the peer.
      const failure = classifyOidcFailure(
        new TypeError('fetch failed', {
          cause: { code: 'ERR_SSL_TLSV1_BAD_CERTIFICATE_STATUS_RESPONSE' },
        }),
      );

      expect(failure).toEqual({ kind: 'unavailable', reason: 'provider_unreachable' });
      expect(failure.reason).not.toBe('client_authentication_failed');
      // And it must still be recognised as an alert rather than falling out as
      // an unread code, which is a different answer with a different move.
      expect(failure.reason).not.toBe('unrecognised_failure');
    });

    it('does not admit a non-alert OpenSSL failure through the slash', () => {
      // The negative half of widening the protocol token: `ERR_SSL_` is still
      // OpenSSL's whole namespace, and a local cipher configuration that fails
      // before the provider is contacted is still not an outage. A code that
      // merely contains a slash is not an alert either.
      for (const code of [
        'ERR_SSL_NO_CIPHER_MATCH',
        'ERR_SSL_SSL/TLS_NO_CIPHER_MATCH',
        'ERR_SSL_TLSV1_SOMETHING_OPENSSL_SPELLS_WITHOUT_ALERT',
      ]) {
        expect(classifyOidcFailure(new TypeError('fetch failed', { cause: { code } }))).toEqual({
          kind: 'defect',
          reason: 'unrecognised_failure',
        });
      }
    });
  });

  describe('the boundary holds for anything at all', () => {
    it('calls a plain programming error a defect, not a sign-in refusal', () => {
      expect(classifyOidcFailure(new TypeError('x is not a function'))).toEqual({
        kind: 'defect',
        reason: 'unrecognised_failure',
      });
    });

    it('survives anything at all being thrown', () => {
      for (const thrown of [undefined, null, 'a string', 42, [], { code: '' }, { code: 7 }]) {
        expect(classifyOidcFailure(thrown)).toEqual({
          kind: 'defect',
          reason: 'unrecognised_failure',
        });
      }
    });

    it('does not itself throw when a property getter does', () => {
      // The classifier is the safe boundary a `catch` handed its value to. If
      // reading that value can throw out of here, the boundary is not one.
      const throwingCode = {
        get code(): string {
          throw new Error('nope');
        },
      };
      const throwingCause = {
        code: 'OAUTH_UNKNOWN',
        get cause(): unknown {
          throw new Error('nope');
        },
      };

      expect(classifyOidcFailure(throwingCode)).toEqual({
        kind: 'defect',
        reason: 'unreadable_failure',
      });
      expect(classifyOidcFailure(throwingCause)).toEqual({
        kind: 'defect',
        reason: 'unreadable_failure',
      });
    });

    it('does not let a provider string reach the reason slug', () => {
      // Finding 4: the doc comment promises an app-owned slug, so no input may
      // produce one this project did not write.
      const owned = new Set([
        'grant_refused',
        'claims_refused',
        'provider_unreachable',
        'provider_reported_outage',
        'provider_response_unusable',
        'client_authentication_failed',
        'request_rejected',
        'local_defect',
        'tls_negotiation_failed',
        'unrecognised_failure',
        'unreadable_failure',
      ]);

      for (const thrown of [
        { code: '<script>alert(1)</script>' },
        { code: 'OAUTH_RESPONSE_BODY_ERROR', error: 'a whole sentence from a vendor', status: 400 },
        { code: 'OAUTH_AUTHORIZATION_RESPONSE_ERROR', error: 'ANY_THING' },
        new TypeError('fetch failed', { cause: { code: 'SOMETHING_NEW' } }),
      ]) {
        // Asserted exactly, then asserted against the union — the first catches
        // a wrong arm, the second catches a slug nobody here wrote.
        const failure = classifyOidcFailure(thrown);

        expect(failure).toEqual({ kind: 'defect', reason: 'unrecognised_failure' });
        expect(owned.has(failure.reason)).toBe(true);
      }
    });
  });
});
