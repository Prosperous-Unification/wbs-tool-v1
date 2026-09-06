import { describe, expect, it } from 'bun:test';

import { classifyOidcFailure } from './oidc-failure';

/**
 * Every case here builds a plain object with a `code`, never an instance of a
 * library error. That is the contract: if this file had to import a class from
 * `openid-client` to write a case, the classifier would be reading the
 * dependency's internals and the whole point of owning the union would be gone.
 */
describe('classifyOidcFailure', () => {
  it('calls a spent or wrong code a refusal', () => {
    expect(classifyOidcFailure({ code: 'OAUTH_RESPONSE_BODY_ERROR' })).toEqual({
      kind: 'refused',
      reason: 'OAUTH_RESPONSE_BODY_ERROR',
    });
  });

  it('calls an error the provider put in the callback a refusal', () => {
    expect(classifyOidcFailure({ code: 'OAUTH_AUTHORIZATION_RESPONSE_ERROR' }).kind).toBe(
      'refused',
    );
  });

  it('calls rejected client credentials a refusal', () => {
    expect(classifyOidcFailure({ code: 'OAUTH_WWW_AUTHENTICATE_CHALLENGE' }).kind).toBe('refused');
  });

  it('calls an ID token whose claims do not check out a refusal', () => {
    expect(classifyOidcFailure({ code: 'OAUTH_JWT_TIMESTAMP_CHECK_FAILED' }).kind).toBe('refused');
    expect(classifyOidcFailure({ code: 'OAUTH_JWT_CLAIM_COMPARISON_FAILED' }).kind).toBe('refused');
  });

  it('calls an unresolvable issuer unavailable, not a refusal', () => {
    // What a real DNS failure looks like by the time it leaves `fetch`: a bare
    // TypeError with the only useful fact one level down in `cause`. This is the
    // case the task exists for — today it is answered exactly like a bad code.
    const failure = classifyOidcFailure(
      new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }),
    );

    expect(failure).toEqual({ kind: 'unavailable', reason: 'transport:ENOTFOUND' });
  });

  it('calls a refused connection and an expired certificate unavailable', () => {
    expect(
      classifyOidcFailure(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })).kind,
    ).toBe('unavailable');
    expect(
      classifyOidcFailure(new TypeError('fetch failed', { cause: { code: 'CERT_HAS_EXPIRED' } }))
        .kind,
    ).toBe('unavailable');
  });

  it('finds a transport failure buried more than one cause deep', () => {
    const failure = classifyOidcFailure({
      message: 'discovery failed',
      cause: new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }),
    });

    expect(failure.kind).toBe('unavailable');
    expect(failure.reason).toBe('transport:UND_ERR_CONNECT_TIMEOUT');
  });

  it('calls a response that is not the provider speaking unavailable', () => {
    // A gateway serving an HTML error page during an outage, not a caller problem.
    expect(classifyOidcFailure({ code: 'OAUTH_RESPONSE_IS_NOT_JSON' }).kind).toBe('unavailable');
    expect(classifyOidcFailure({ code: 'OAUTH_RESPONSE_IS_NOT_CONFORM' }).kind).toBe('unavailable');
    expect(classifyOidcFailure({ code: 'OAUTH_PARSE_ERROR' }).kind).toBe('unavailable');
  });

  it('calls our own misconfiguration a defect rather than a refusal', () => {
    expect(classifyOidcFailure({ code: 'OAUTH_INVALID_REQUEST' })).toEqual({
      kind: 'defect',
      reason: 'OAUTH_INVALID_REQUEST',
    });
  });

  it('calls a code it has never seen a defect, keeping its name for the log', () => {
    // The guard against a future library code being read as something it is not:
    // an unrecognised code must not fall into `refused`.
    expect(classifyOidcFailure({ code: 'OAUTH_SOMETHING_ADDED_IN_A_LATER_VERSION' })).toEqual({
      kind: 'defect',
      reason: 'OAUTH_SOMETHING_ADDED_IN_A_LATER_VERSION',
    });
  });

  it('calls a plain programming error a defect, not a sign-in refusal', () => {
    expect(classifyOidcFailure(new TypeError('x is not a function'))).toEqual({
      kind: 'defect',
      reason: 'unclassified',
    });
  });

  it('survives anything at all being thrown', () => {
    for (const thrown of [undefined, null, 'a string', 42, [], { code: '' }, { code: 7 }]) {
      expect(classifyOidcFailure(thrown).kind).toBe('defect');
    }
  });
});
