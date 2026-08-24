import type { TokenVerifier } from '@wbs/auth';
import { describe, expect, it } from 'bun:test';
import { generateKeyPair, SignJWT } from 'jose';

import { authenticateCaller } from './caller-auth';

const claims = {
  iss: 'https://idp.example',
  sub: 'person-1',
  wbs_groups: ['dev:wbs:read', 'dev:wbs:write'],
};

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return '(resolved without throwing)';
  } catch (error) {
    return String(error);
  }
}

describe('authenticateCaller', () => {
  // Proof: replacing verifier.verify with decodeJwt made this test accept the throwing verifier.
  it('verifies standalone Bearer tokens and exposes their WBS scopes', async () => {
    const verifier: TokenVerifier = { verify: () => Promise.resolve(claims) };
    expect(
      await authenticateCaller('Bearer signed', 'standalone', verifier, 'dev', 'wbs_groups'),
    ).toMatchObject({ token: 'signed', clientId: 'person-1', scopes: ['read', 'write'] });
  });

  // Break caught: returning the presented local token here leaks the wrong
  // issuer/audience credential to be-01 instead of its server-held Okta token.
  it('uses a verifier-provided downstream token without exposing it in the local JWT', async () => {
    const verifier: TokenVerifier & { upstreamTokenFor(token: string): Promise<string> } = {
      verify: () => Promise.resolve(claims),
      upstreamTokenFor: (token) =>
        token === 'local-mcp-token'
          ? Promise.resolve('upstream-okta-token')
          : Promise.reject(new Error('unexpected token')),
    };
    expect(
      await authenticateCaller(
        'Bearer local-mcp-token',
        'standalone',
        verifier,
        'dev',
        'wbs_groups',
      ),
    ).toMatchObject({ token: 'upstream-okta-token', clientId: 'person-1' });
  });

  // Proof: attempting verification in gateway mode made this test throw from the verifier.
  it('decodes a trusted gateway token without signature verification', async () => {
    const { privateKey } = await generateKeyPair('RS256');
    const token = await new SignJWT(claims).setProtectedHeader({ alg: 'RS256' }).sign(privateKey);
    const verifier: TokenVerifier = { verify: () => Promise.reject(new Error('must not verify')) };
    expect(
      await authenticateCaller(`Bearer ${token}`, 'gateway', verifier, 'dev', 'wbs_groups'),
    ).toMatchObject({ token, clientId: 'person-1', scopes: ['read', 'write'] });
  });

  it('refuses a missing or malformed Bearer credential', async () => {
    const verifier: TokenVerifier = { verify: () => Promise.resolve(claims) };
    expect(
      await rejection(authenticateCaller(null, 'standalone', verifier, 'dev', 'wbs_groups')),
    ).toMatch(/Bearer/);
    expect(
      await rejection(
        authenticateCaller('Basic nope', 'standalone', verifier, 'dev', 'wbs_groups'),
      ),
    ).toMatch(/Bearer/);
  });
});
