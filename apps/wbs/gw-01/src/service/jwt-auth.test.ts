import { describe, expect, it } from 'bun:test';
import { SignJWT } from 'jose';

import { JwtVerifier } from './jwt-auth';

/**
 * An HS256 secret as the bytes gw-01 actually holds.
 *
 * jose's `generateSecret` answers `Uint8Array | KeyLike` and, in this runtime, a
 * `CryptoKey` — a key kind gw-01 never has, since its secret arrives as an env
 * var and is encoded ({@link buildApp}). Four `as Uint8Array` casts here stood
 * in for that mismatch, uncompiled by any gate until 2026-09-02. A distinct
 * name gives a distinct key, which is what the rotation cases need.
 */
function secretFor(name: string): Uint8Array {
  return new TextEncoder().encode(`${name}-secret-of-at-least-thirty-two-bytes`);
}

async function makeToken(secret: Uint8Array, sub = 'user-1'): Promise<string> {
  return await new SignJWT({ sub }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().sign(secret);
}

describe('JwtVerifier', () => {
  it('routes OIDC tokens to the primary and password tokens to the local key', async () => {
    const current = secretFor('current');
    const primaryCalls: string[] = [];
    const verifier = new JwtVerifier({
      current,
      primary: {
        verify: (token) => {
          primaryCalls.push(token);
          return token === 'oidc-access-token'
            ? Promise.resolve({ sub: 'oidc-user' })
            : Promise.reject(new Error('not an OIDC token'));
        },
      },
    });

    expect(await verifier.verify('oidc-access-token')).toEqual({ sub: 'oidc-user' });
    expect((await verifier.verify(await makeToken(current, 'password-user'))).sub).toBe(
      'password-user',
    );
    expect(primaryCalls).toEqual(['oidc-access-token']);
  });

  it('propagates an OIDC verifier outage instead of disguising it as a local rejection', async () => {
    const current = secretFor('current');
    const outage = new Error('JWKS endpoint unavailable');
    const verifier = new JwtVerifier({
      current,
      primary: { verify: () => Promise.reject(outage) },
    });
    const oidcShaped = [
      Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: 'oidc-user' })).toString('base64url'),
      'signature',
    ].join('.');

    let caught: unknown;
    try {
      await verifier.verify(oidcShaped);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(outage);
  });

  it('accepts a CURRENT-signed token', async () => {
    const cur = secretFor('current');
    const verifier = new JwtVerifier({ current: cur });
    const token = await makeToken(cur);
    const result = await verifier.verify(token);
    expect(result.sub).toBe('user-1');
  });

  it('falls back to PREVIOUS on invalid signature only', async () => {
    const cur = secretFor('current');
    const prev = secretFor('previous');
    const verifier = new JwtVerifier({ current: cur, previous: prev });
    const token = await makeToken(prev);
    const result = await verifier.verify(token);
    expect(result.sub).toBe('user-1');
  });

  it('does not fall back on expired token even if PREVIOUS exists', async () => {
    const cur = secretFor('current');
    const prev = secretFor('previous');
    const verifier = new JwtVerifier({ current: cur, previous: prev });
    const expired = await new SignJWT({ sub: 'u' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(1000)
      .setExpirationTime(2000)
      .sign(cur);
    let caught: unknown;
    try {
      await verifier.verify(expired);
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).toMatch(/exp/i);
  });
});
