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
 * The shape follows {@link RefreshRotationResult}, declared with the token store
 * further down this file, which answered the same question — "the record is
 * fine, *you* are not it" is not "there is no record" — for refresh rotation.
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
   * **The two-tab residual recorded here before is half closed by this, and
   * the surviving half is the tab that lost its cookie** — both review seats
   * caught the earlier wording, which claimed the whole thing was untouched.
   * Two logins started in two tabs share one cookie name, so the second
   * overwrites the browser's binding. The first tab's stale callback then
   * arrives carrying the *second* tab's binding and the *first* tab's state,
   * which is precisely a mismatch: under the old ordering it burnt the second
   * tab's live record on the way to the 400, and it no longer does — the second
   * tab's record and cookie both survive and its own callback still completes.
   * What remains is that the **first** tab cannot finish at all, because its
   * binding was replaced before its callback came back and no ordering here can
   * recover a cookie the browser has already overwritten; its orphaned record
   * waits for expiry. That half is one-cookie-per-browser and it is TASK-272.
   */
  consume(browserBinding: string, state: string): OidcConsumeResult {
    const key = digest(browserBinding);
    const transaction = this.records.get(key);
    // Proof: `refuses another browser without consuming the initiating browser
    // transaction` fails if a callback can address a record by state alone.
    if (transaction === undefined) return { outcome: 'missing' };

    // Proof: `refuses and removes an expired transaction` fails if an expired
    // callback can still recover its verifier, and `reports an expired
    // transaction as expired even when the state also mismatches` fails with
    // `Received: {"outcome": "state_mismatch"}` if this is ordered after the
    // comparison below — a dead record preserved on that call by the arm that
    // exists to protect a live login. It would still be swept by the next
    // `save`'s whole-map cleanup rather than kept forever; the defect is the
    // preservation on this call, which is the narrower and true claim.
    if (transaction.expiresAt <= this.now()) {
      this.records.delete(key);
      return { outcome: 'expired' };
    }
    // Proof: restoring the delete here reddens two named cases with the exact
    // symptom of the defect. `keeps the initiating browser transaction when a
    // forged callback returns the wrong state` fails at the *honest* consume
    // with `Received: {"outcome": "missing"}` where the payload belongs, and
    // `refuses a forged error callback without burning the login it interrupts`
    // fails in `oidc.integration.test.ts` with `Expected: 302 Received: 400` —
    // the login the forged navigation destroyed, one layer up.
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
