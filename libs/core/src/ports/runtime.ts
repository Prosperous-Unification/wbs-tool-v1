/**
 * What a service needs from the runtime it happens to be running in.
 *
 * Ports rather than calls, for one reason each (plan §3.4, D10): `Bun.password`
 * exists in Bun and nowhere else; `jose` runs anywhere but signing is still a
 * capability a composition root should hand over rather than a service reach
 * for; `node:crypto`'s `createHash` is synchronous and Node's, while a browser
 * has `crypto.subtle` and it is not.
 *
 * None of them has a default. A default is the composition root's decision made
 * somewhere else, and the two places it was made here — `Bun.password` inside
 * `AuthService`, `setInterval` inside `RetentionTimer` — are exactly the two a
 * second runtime would have had to notice and could not have been told about.
 */

/** Hashing and checking a password, whatever the runtime hashes with. */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  /**
   * Whether `password` produced `hash`.
   *
   * Answers `false` for a wrong password and **throws** for a hash it cannot
   * read: an unreadable stored credential is an unknown, not a refusal (R5).
   */
  verify(password: string, hash: string): Promise<boolean>;
}

/** One signed session token: what it says, and how long it says it for. */
export interface SessionClaims {
  subject: string;
  username: string;
}

/**
 * Signing and verifying this deployment's own session tokens.
 *
 * `verify` answers `null` for a token that is merely invalid — expired, wrong
 * signature, malformed — and throws for anything else, because "the key is not
 * configured" and "this token is not yours" are different sentences and only
 * one of them is the caller's fault.
 */
export interface TokenCodec {
  sign(claims: SessionClaims, ttlSeconds: number): Promise<string>;
  verify(token: string): Promise<SessionClaims | null>;
}

/**
 * A SHA-256 over the exact bytes it is handed.
 *
 * `Promise` because a browser's `crypto.subtle.digest` is asynchronous and
 * Node's `createHash` is not: a port that answered synchronously would be
 * Node's shape, and the one runtime that cannot meet it is the one this exists
 * for.
 */
export interface Digest {
  sha256(bytes: string): Promise<string>;
}
