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

    it('calls a failing provider unavailable even though it answered in OAuth shape', () => {
      // Without this row the outage this task exists to separate is answered
      // 401, which is the status quo with more ceremony.
      expect(classifyOidcFailure(bodyError('server_error', 500))).toEqual({
        kind: 'unavailable',
        reason: 'provider_reported_outage',
      });
      expect(classifyOidcFailure(bodyError('temporarily_unavailable', 503))).toEqual({
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
      for (const code of [
        'OAUTH_RESPONSE_IS_NOT_JSON',
        'OAUTH_RESPONSE_IS_NOT_CONFORM',
        'OAUTH_INVALID_RESPONSE',
      ]) {
        expect(classifyOidcFailure({ code })).toEqual({
          kind: 'unavailable',
          reason: 'provider_response_unusable',
        });
      }
    });

    it('calls a rejected client challenge a defect', () => {
      expect(classifyOidcFailure({ code: 'OAUTH_WWW_AUTHENTICATE_CHALLENGE' })).toEqual({
        kind: 'defect',
        reason: 'client_authentication_failed',
      });
    });

    it('calls our own malformed request or unparseable input a defect', () => {
      expect(classifyOidcFailure({ code: 'OAUTH_INVALID_REQUEST' })).toEqual({
        kind: 'defect',
        reason: 'request_rejected',
      });
      expect(classifyOidcFailure({ code: 'OAUTH_PARSE_ERROR' })).toEqual({
        kind: 'defect',
        reason: 'local_defect',
      });
      expect(classifyOidcFailure({ code: 'OAUTH_UNSUPPORTED_OPERATION' })).toEqual({
        kind: 'defect',
        reason: 'local_defect',
      });
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
      for (const code of ['ECONNREFUSED', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID']) {
        expect(classifyOidcFailure(new TypeError('fetch failed', { cause: { code } }))).toEqual({
          kind: 'unavailable',
          reason: 'provider_unreachable',
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
        'unrecognised_failure',
        'unreadable_failure',
      ]);

      for (const thrown of [
        { code: '<script>alert(1)</script>' },
        { code: 'OAUTH_RESPONSE_BODY_ERROR', error: 'a whole sentence from a vendor', status: 400 },
        { code: 'OAUTH_AUTHORIZATION_RESPONSE_ERROR', error: 'ANY_THING' },
        new TypeError('fetch failed', { cause: { code: 'SOMETHING_NEW' } }),
      ]) {
        expect(owned.has(classifyOidcFailure(thrown).reason)).toBe(true);
      }
    });
  });
});
