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

export interface OidcTransactionStore {
  cleanupExpired(): number;
  consume(browserBinding: string, state: string): ConsumedOidcTransaction | null;
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

  consume(browserBinding: string, state: string): ConsumedOidcTransaction | null {
    const key = digest(browserBinding);
    const transaction = this.records.get(key);
    // Proof: `refuses another browser without consuming the initiating browser
    // transaction` fails if a callback can address a record by state alone.
    if (transaction === undefined) return null;

    this.records.delete(key);
    // Proof: `refuses and removes an expired transaction` fails if an expired
    // callback can still recover its verifier.
    if (transaction.expiresAt <= this.now()) return null;
    // Proof: `burns a transaction when the initiating browser returns the wrong
    // state` fails if a mismatched callback remains reusable.
    if (!sameSecret(transaction.state, state)) return null;

    return { nonce: transaction.nonce, verifier: transaction.verifier };
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
