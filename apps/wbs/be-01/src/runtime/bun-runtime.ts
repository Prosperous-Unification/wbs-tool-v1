import { createHash } from 'node:crypto';

import type { Digest, Intervals, PasswordHasher, SessionClaims, TokenCodec } from '@wbs/core';
import { errors, type JWTPayload, jwtVerify, SignJWT } from 'jose';

/**
 * Argon2id through `Bun.password` — the only implementation this process has,
 * and the reason the port exists.
 *
 * `Bun.password.verify` throws on a hash it cannot parse rather than answering
 * `false`, and that is kept: a stored credential nothing can read is an unknown
 * (R5), and a caller that read it as "wrong password" would lock an account out
 * with a 401 that says the opposite of what happened.
 */
export const bunPasswordHasher: PasswordHasher = {
  hash: (password) => Bun.password.hash(password),
  verify: (password, hash) => Bun.password.verify(password, hash),
};

/**
 * HS256 session tokens through `jose`.
 *
 * Isomorphic in principle — `jose` runs in a browser — and behind a port all
 * the same, because *whether this deployment signs its own sessions* is the
 * composition root's answer and not a service's.
 */
export function joseTokenCodec(jwtKey: string): TokenCodec {
  const key = new TextEncoder().encode(jwtKey);
  return {
    async sign(claims: SessionClaims, ttlSeconds: number): Promise<string> {
      const issuedAt = Math.floor(Date.now() / 1000);
      return await new SignJWT({ username: claims.username })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(claims.subject)
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + ttlSeconds)
        .sign(key);
    },
    async verify(token: string): Promise<SessionClaims | null> {
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, key));
      } catch (cause) {
        // A token that is expired, forged or malformed is a modeled condition
        // and answers `null`; anything else — a key this process cannot use,
        // say — is an unknown and is thrown.
        if (cause instanceof errors.JOSEError) return null;
        throw cause;
      }
      const subject = payload.sub;
      const username = payload['username'];
      if (typeof subject !== 'string' || typeof username !== 'string') return null;
      return { subject, username };
    },
  };
}

/**
 * SHA-256 through `node:crypto`, awaited to meet the port.
 *
 * The `await` is not decoration: the port is asynchronous because a browser's
 * `crypto.subtle.digest` is, and an adapter that answered synchronously would
 * let a caller depend on an ordering the other runtime cannot give it.
 */
export const nodeDigest: Digest = {
  sha256: (bytes) => Promise.resolve(createHash('sha256').update(bytes, 'utf8').digest('hex')),
};

/**
 * The repeating half of this runtime's timers, for {@link RetentionTimer}.
 *
 * Named here rather than defaulted inside the timer, which is the whole of D10
 * in one line: what repeats work is the process's answer, and a process that
 * has no `setInterval` — a browser tab that is asleep, a worker with its own
 * scheduler — has to be able to give a different one.
 */
export const systemInterval: Intervals = {
  every: (milliseconds, callback) => {
    const interval = setInterval(callback, milliseconds);
    return () => {
      clearInterval(interval);
    };
  },
};
