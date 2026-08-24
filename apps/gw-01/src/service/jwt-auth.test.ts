import { describe, expect, it } from 'bun:test';
import { generateSecret, SignJWT } from 'jose';

import { JwtVerifier } from './jwt-auth';

async function makeToken(secret: Uint8Array, sub = 'user-1'): Promise<string> {
  return await new SignJWT({ sub }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().sign(secret);
}

describe('JwtVerifier', () => {
  it('tries the OIDC verifier before the local password-session keys', async () => {
    const current = await generateSecret('HS256');
    const verifier = new JwtVerifier({
      current,
      primary: {
        verify: (token) =>
          token === 'oidc-access-token'
            ? Promise.resolve({ sub: 'oidc-user' })
            : Promise.reject(new Error('not an OIDC token')),
      },
    } as ConstructorParameters<typeof JwtVerifier>[0]);

    expect(await verifier.verify('oidc-access-token')).toEqual({ sub: 'oidc-user' });
    expect((await verifier.verify(await makeToken(current, 'password-user'))).sub).toBe(
      'password-user',
    );
  });

  it('accepts a CURRENT-signed token', async () => {
    const cur = (await generateSecret('HS256')) as Uint8Array;
    const verifier = new JwtVerifier({ current: cur });
    const token = await makeToken(cur);
    const result = await verifier.verify(token);
    expect(result.sub).toBe('user-1');
  });

  it('falls back to PREVIOUS on invalid signature only', async () => {
    const cur = (await generateSecret('HS256')) as Uint8Array;
    const prev = (await generateSecret('HS256')) as Uint8Array;
    const verifier = new JwtVerifier({ current: cur, previous: prev });
    const token = await makeToken(prev);
    const result = await verifier.verify(token);
    expect(result.sub).toBe('user-1');
  });

  it('does not fall back on expired token even if PREVIOUS exists', async () => {
    const cur = (await generateSecret('HS256')) as Uint8Array;
    const prev = (await generateSecret('HS256')) as Uint8Array;
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
