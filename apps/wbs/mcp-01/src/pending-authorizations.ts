import { digestOidcBinding, InMemoryOidcTransactionStore } from '@wbs/auth';

/** MCP client context retained separately from upstream OIDC proof material. */
export interface AuthorizationContext {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  scope: string;
  state?: string;
}

/** The terminal or retryable outcome of consuming one pending authorization. */
export type PendingOutcome =
  | {
      authorization: AuthorizationContext;
      nonce: string;
      outcome: 'consumed';
      verifier: string;
    }
  | { outcome: 'expired' }
  | { outcome: 'missing' }
  | { outcome: 'state_mismatch' };

interface StoredAuthorization {
  authorization: AuthorizationContext;
  expiresAt: number;
}

interface PendingAuthorizationOptions {
  globalLimit: number;
  now?: () => number;
  perClientLimit: number;
  ttlMs: number;
}

/**
 * Owns OIDC proof records and the bounded MCP context that completes them.
 * Every operation holds one clock reading across both maps.
 */
export class PendingAuthorizations {
  private readonly contexts = new Map<string, StoredAuthorization>();
  private readonly now: () => number;
  private heldNow = 0;
  private readonly transactions: InMemoryOidcTransactionStore;

  constructor(private readonly options: PendingAuthorizationOptions) {
    this.now = options.now ?? Date.now;
    this.transactions = new InMemoryOidcTransactionStore({
      now: () => this.heldNow,
      ttlMs: options.ttlMs,
    });
  }

  /** Saves proof and context synchronously, or refuses without evicting a live login. */
  save(
    browserBinding: string,
    upstreamState: string,
    nonce: string,
    verifier: string,
    authorization: AuthorizationContext,
  ): 'capacity' | 'saved' {
    const now = this.holdNow();
    this.cleanupAt(now);
    const key = digestOidcBinding(browserBinding);
    if (this.contexts.has(key) || this.transactions.expiresAt(browserBinding) !== null) {
      throw new Error('generated OIDC browser binding collided with a live authorization');
    }
    const clientCount = [...this.contexts.values()].filter(
      (stored) => stored.authorization.clientId === authorization.clientId,
    ).length;
    if (
      this.contexts.size >= this.options.globalLimit ||
      clientCount >= this.options.perClientLimit
    ) {
      return 'capacity';
    }

    this.transactions.save({ browserBinding, nonce, state: upstreamState, verifier });
    this.contexts.set(key, { authorization, expiresAt: now + this.options.ttlMs });
    return 'saved';
  }

  /** Consumes matched proof and its context once while preserving a live mismatch. */
  consume(browserBinding: string, state: string): PendingOutcome {
    const now = this.holdNow();
    const consumed = this.transactions.consume(browserBinding, state);
    const key = digestOidcBinding(browserBinding);
    if (consumed.outcome === 'state_mismatch') return consumed;
    if (consumed.outcome === 'missing' || consumed.outcome === 'expired') {
      this.contexts.delete(key);
      return consumed;
    }

    const stored = this.contexts.get(key);
    if (stored === undefined || stored.expiresAt <= now) {
      this.contexts.delete(key);
      throw new Error('consumed OIDC proof has no authorization context');
    }
    this.contexts.delete(key);
    return {
      authorization: stored.authorization,
      nonce: consumed.nonce,
      outcome: 'consumed',
      verifier: consumed.verifier,
    };
  }

  /** Removes expired proof and context using the same instant for both maps. */
  cleanupExpired(): void {
    this.cleanupAt(this.holdNow());
  }

  private holdNow(): number {
    const now = this.now();
    this.heldNow = now;
    return now;
  }

  private cleanupAt(now: number): void {
    this.heldNow = now;
    this.transactions.cleanupExpired();
    for (const [key, stored] of this.contexts) {
      if (stored.expiresAt <= now) this.contexts.delete(key);
    }
  }
}
