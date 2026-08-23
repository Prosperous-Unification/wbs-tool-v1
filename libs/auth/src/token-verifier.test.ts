import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { exportJWK, generateKeyPair, type KeyLike, SignJWT } from 'jose';

import { JwksTokenVerifier } from './token-verifier';

const ISSUER = 'https://idp.example.test/oauth2/default';
const AUDIENCE = 'api://wbs';
let privateKey: KeyLike;
let jwksUri: URL;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const publicJwk = await exportJWK(pair.publicKey);
  server = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json({
        keys: [{ ...publicJwk, alg: 'RS256', kid: 'fixture-key', use: 'sig' }],
      }),
  });
  jwksUri = new URL(`http://127.0.0.1:${String(server.port)}/jwks`);
});

afterAll(() => {
  void server.stop(true);
});

async function tokenWith(
  options: {
    audience?: string;
    expiresAt?: number;
    issuer?: string;
  } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({ sub: 'user-1' })
    .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(options.expiresAt ?? now + 300)
    .sign(privateKey);
}

function verifier(): JwksTokenVerifier {
  return new JwksTokenVerifier({ audience: AUDIENCE, issuer: ISSUER, jwksUri });
}

describe('JwksTokenVerifier', () => {
  it('accepts a locally signed RS256 token from the configured issuer and audience', async () => {
    expect((await verifier().verify(await tokenWith())).sub).toBe('user-1');
  });

  it('rejects a token for another audience', async () => {
    expect(verifier().verify(await tokenWith({ audience: 'api://other' }))).rejects.toThrow(
      /aud|audience/i,
    );
  });

  it('rejects a token from another issuer', async () => {
    expect(
      verifier().verify(await tokenWith({ issuer: 'https://other.example.test' })),
    ).rejects.toThrow(/iss|issuer/i);
  });

  it('rejects an expired token', async () => {
    const now = Math.floor(Date.now() / 1000);
    expect(verifier().verify(await tokenWith({ expiresAt: now - 60 }))).rejects.toThrow(
      /exp|expired/i,
    );
  });
});
