import { createHash, timingSafeEqual } from 'node:crypto';

export interface OidcTransactionInput {
  browserBinding: string;
  nonce: string;
  state: string;
  verifier: string;
}

export interface ConsumedOidcTransaction {
  nonce: string;
  verifier: string;
}

/**
 * Why `consume` answers an outcome rather than `ConsumedOidcTransaction | null`
 * (TASK-276): the four ways a callback can fail to consume are not one fact.
 * `missing` and `expired` describe a record that is gone or dead for everyone,
 * and the caller may safely clear the browser's binding on both. `state_mismatch`
 * describes a **live** record that this arrival failed to prove it owns, and a
 * caller that treats it as the other two hands an attacker the login.
 *
 * The shape follows {@link RefreshRotationResult} in this file, which answered
 * the same question — "the record is fine, *you* are not it" is not "there is no
 * record" — one store earlier.
 */
export type OidcConsumeResult =
  | ({ outcome: 'consumed' } & ConsumedOidcTransaction)
  | { outcome: 'expired' | 'missing' | 'state_mismatch' };

export interface OidcTransactionStore {
  cleanupExpired(): number;
  consume(browserBinding: string, state: string): OidcConsumeResult;
  save(transaction: OidcTransactionInput): void;
}

interface StoredOidcTransaction extends OidcTransactionInput {
  expiresAt: number;
}

interface StoreOptions {
  now?: () => number;
}

interface OidcTransactionStoreOptions extends StoreOptions {
  ttlMs: number;
}

/**
 * Keeps short-lived OIDC transactions server-side and consumes each browser
 * binding once. The map key is a digest so the cookie correlation is not kept
 * verbatim in memory.
 */
export class InMemoryOidcTransactionStore implements OidcTransactionStore {
  private readonly now: () => number;
  private readonly records = new Map<string, StoredOidcTransaction>();

  constructor(private readonly options: OidcTransactionStoreOptions) {
    this.now = options.now ?? Date.now;
    if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
      throw new Error('OIDC transaction TTL must be positive');
    }
  }

  save(transaction: OidcTransactionInput): void {
    this.cleanupExpired();
    this.records.set(digest(transaction.browserBinding), {
      ...transaction,
      expiresAt: this.now() + this.options.ttlMs,
    });
  }

  /**
   * **A mismatched state leaves the record alone — reversed 2026-09-06 under
   * TASK-276, and it reverses a decision this file argued for under TASK-269.**
   *
   * The earlier ordering deleted before it compared, on the grounds that a
   * record left behind after a mismatch is a record anything holding the
   * binding cookie may keep trying states against. That reading is real but
   * priced wrong, and the two threats it weighs are not the same size:
   *
   * - Guessing `state` costs an attacker 256 bits. It is `randomBytes(32)`
   *   (`auth.routes.ts`), so the retry oracle the old ordering avoided was
   *   never reachable.
   * - Burning the record cost an attacker **one navigation**. The binding
   *   cookie is `SameSite=Lax`, so a hostile page could send a browser with a
   *   login in flight to `?error=…&state=anything`, the record died on
   *   arrival, and the real callback a second later failed. No guess required.
   *
   * So the mismatch arm keeps the record and reports {@link OidcConsumeResult}
   * `state_mismatch`, and the caller answers its usual refusal **without**
   * clearing the binding — clearing it would lose the login the surviving
   * record exists to finish, which is the same denial by a different route.
   *
   * **Single-use moves from the arrival to the match, and is still single-use.**
   * It was enforced by deleting whatever turned up; it is now enforced by
   * deleting only what proves it owns the record, so a replayed *correct* state
   * finds `missing`. Expiry still deletes on sight and is checked first: a dead
   * record is dead for everyone, and preserving one would be a leak with no
   * login left to protect.
   *
   * **The two-tab residual recorded here before does not move and is not fixed
   * by this:** two logins started in two tabs share one cookie name, so the
   * second overwrites the browser's binding and the first tab's stale callback
   * still costs the second tab its transaction. That is one-cookie-per-browser,
   * it is TASK-272, and this change neither closes nor widens it.
   */
  consume(browserBinding: string, state: string): OidcConsumeResult {
    const key = digest(browserBinding);
    const transaction = this.records.get(key);
    // Proof: `refuses another browser without consuming the initiating browser
    // transaction` fails if a callback can address a record by state alone.
    if (transaction === undefined) return { outcome: 'missing' };

    // Proof: `refuses and removes an expired transaction` fails if an expired
    // callback can still recover its verifier, and `reports an expired
    // transaction as expired even when the state also mismatches` fails —
    // leaving a dead record behind forever — if this is ordered after the
    // comparison below.
    if (transaction.expiresAt <= this.now()) {
      this.records.delete(key);
      return { outcome: 'expired' };
    }
    // Proof: `keeps the initiating browser transaction when a forged callback
    // returns the wrong state` fails if this deletes, and `refuses a forged
    // error callback without burning the login it interrupts` reddens in
    // `oidc.integration.test.ts` at the same time.
    if (!sameSecret(transaction.state, state)) return { outcome: 'state_mismatch' };

    this.records.delete(key);
    return { nonce: transaction.nonce, outcome: 'consumed', verifier: transaction.verifier };
  }

  cleanupExpired(): number {
    const now = this.now();
    let removed = 0;
    for (const [key, transaction] of this.records) {
      if (transaction.expiresAt <= now) {
        this.records.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}

export interface RefreshRecordInput {
  expiresAt: number;
  refreshToken: string;
  sessionCorrelation: string;
}

export interface RefreshRecord {
  expiresAt: number;
  refreshToken: string;
}

export interface RefreshRotationInput extends RefreshRecordInput {
  previousRefreshToken: string;
}

export type RefreshRotationResult = 'expired' | 'invalid' | 'missing' | 'replay' | 'rotated';

export interface TokenStore {
  cleanupExpired(): number;
  delete(sessionCorrelation: string): boolean;
  read(sessionCorrelation: string): RefreshRecord | null;
  rotate(rotation: RefreshRotationInput): RefreshRotationResult;
  save(record: RefreshRecordInput): void;
}

interface StoredRefreshRecord extends RefreshRecord {
  spentRefreshTokens: Set<string>;
}

/**
 * Keeps refresh tokens server-side under digested session correlations and
 * detects reuse of a token that already completed a rotation.
 */
export class InMemoryTokenStore implements TokenStore {
  private readonly now: () => number;
  private readonly records = new Map<string, StoredRefreshRecord>();

  constructor(options: StoreOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  save(record: RefreshRecordInput): void {
    this.cleanupExpired();
    this.records.set(digest(record.sessionCorrelation), {
      expiresAt: record.expiresAt,
      refreshToken: record.refreshToken,
      spentRefreshTokens: new Set(),
    });
  }

  read(sessionCorrelation: string): RefreshRecord | null {
    const key = digest(sessionCorrelation);
    const record = this.records.get(key);
    if (record === undefined) return null;
    // Proof: `removes expired and logged-out sessions` fails if the expiry
    // boundary still returns refresh material.
    if (record.expiresAt <= this.now()) {
      this.records.delete(key);
      return null;
    }
    return { expiresAt: record.expiresAt, refreshToken: record.refreshToken };
  }

  rotate(rotation: RefreshRotationInput): RefreshRotationResult {
    const key = digest(rotation.sessionCorrelation);
    const record = this.records.get(key);
    if (record === undefined) return 'missing';
    if (record.expiresAt <= this.now()) {
      this.records.delete(key);
      return 'expired';
    }

    const previousDigest = digest(rotation.previousRefreshToken);
    // Proof: `detects replay of a rotated token and ends the session` fails if
    // a concurrent refresh can reuse the predecessor after rotation.
    if (record.spentRefreshTokens.has(previousDigest)) {
      this.records.delete(key);
      return 'replay';
    }
    // Proof: `refuses an unknown previous token without ending the session`
    // fails if an unrelated token can replace or destroy the live record.
    if (!sameSecret(record.refreshToken, rotation.previousRefreshToken)) return 'invalid';

    this.records.set(key, {
      expiresAt: rotation.expiresAt,
      refreshToken: rotation.refreshToken,
      spentRefreshTokens: new Set([...record.spentRefreshTokens, previousDigest]),
    });
    return 'rotated';
  }

  delete(sessionCorrelation: string): boolean {
    return this.records.delete(digest(sessionCorrelation));
  }

  cleanupExpired(): number {
    const now = this.now();
    let removed = 0;
    for (const [key, record] of this.records) {
      if (record.expiresAt <= now) {
        this.records.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}

function digest(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function sameSecret(left: string, right: string): boolean {
  const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
  return timingSafeEqual(encode(digest(left)), encode(digest(right)));
}
