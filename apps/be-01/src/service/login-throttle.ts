interface AttemptWindow {
  failures: number;
  inFlight: number;
  expiresAt: number;
}

export interface LoginThrottleOptions {
  now?: () => number;
  maxConcurrent: number;
}

const FAILURE_LIMIT = 5;
const WINDOW_MS = 60_000;
const MAX_ENTRIES = 10_000;

/**
 * Fixed-window failure limits and per-process admission for password verification.
 * Pending attempts survive window expiry and another attempt's successful login.
 * The bounded map fails closed when no new account/IP can be retained.
 */
export class LoginThrottle {
  private readonly attempts = new Map<string, AttemptWindow>();
  private readonly now: () => number;
  private active = 0;

  constructor(private readonly options: LoginThrottleOptions) {
    // Proof: removing validation makes all five "refuses invalid global cap" cases stop throwing.
    if (!Number.isSafeInteger(options.maxConcurrent) || options.maxConcurrent <= 0) {
      throw new Error('Login concurrency must be a positive integer');
    }
    this.now = options.now ?? Date.now;
  }

  canAttempt(username: string, clientIp: string): boolean {
    const now = this.now();
    const keys = this.keys(username, clientIp);
    this.prune(now, keys);
    const withinFailureLimit = keys.every((key) => {
      const window = this.attempts.get(key);
      // Proof: omitting inFlight makes "reserves at most five held attempts" observe eight.
      return window === undefined || window.failures + window.inFlight < FAILURE_LIMIT;
    });
    if (!withinFailureLimit) return false;
    const newEntries = keys.filter((key) => !this.attempts.has(key)).length;
    return this.attempts.size + newEntries <= MAX_ENTRIES;
  }

  /**
   * Reserves account, IP and global capacity before the caller starts async work.
   * The returned release belongs to one attempt and must run once in its finally.
   * No queue is held: exhausted capacity is an immediate modeled refusal.
   */
  reserve(username: string, clientIp: string): (() => void) | null {
    // Proof: removing this comparison makes "applies the configured global cap" observe three, not two.
    if (this.active >= this.options.maxConcurrent || !this.canAttempt(username, clientIp)) {
      return null;
    }
    const admitted = this.keys(username, clientIp).map((key) => {
      const window = this.attempts.get(key) ?? {
        failures: 0,
        inFlight: 0,
        expiresAt: this.now() + WINDOW_MS,
      };
      window.inFlight += 1;
      this.attempts.set(key, window);
      return { key, window };
    });
    this.active += 1;
    return () => {
      this.active -= 1;
      for (const { key, window } of admitted) {
        // Proof: omitting this decrement makes "starts the failure window when verification refuses"
        // observe five admissions instead of six after expiry.
        window.inFlight -= 1;
        if (window.inFlight === 0 && window.failures === 0) this.attempts.delete(key);
      }
    };
  }

  recordFailure(username: string, clientIp: string): void {
    const now = this.now();
    const keys = this.keys(username, clientIp);
    this.prune(now, keys);
    for (const key of keys) {
      const current = this.attempts.get(key);
      if (current === undefined) {
        if (this.attempts.size >= MAX_ENTRIES) continue;
        this.attempts.set(key, { failures: 1, inFlight: 0, expiresAt: now + WINDOW_MS });
      } else {
        // Proof: keeping admission time makes "starts the failure window when verification refuses"
        // observe six admissions instead of five at 62s.
        if (current.failures === 0) current.expiresAt = now + WINDOW_MS;
        current.failures += 1;
      }
    }
  }

  recordSuccess(username: string): void {
    const key = this.usernameKey(username);
    const window = this.attempts.get(key);
    if (window === undefined) return;
    // Proof: deleting this window makes "retains other pending reservations when one login succeeds"
    // observe seven verifications instead of six.
    if (window.inFlight === 0) this.attempts.delete(key);
    else window.failures = 0;
  }

  private keys(username: string, clientIp: string): string[] {
    return [this.usernameKey(username), `ip:${clientIp}`];
  }

  private usernameKey(username: string): string {
    return `username:${username.trim().toLowerCase().slice(0, 32)}`;
  }

  /**
   * Drops the expired windows for **these two keys**, plus one older entry.
   *
   * It walked the whole map on every call, which is `MAX_ENTRIES` iterations per
   * login attempt — so under the load this class exists to survive, the throttle
   * was itself the O(n) cost.
   *
   * The single extra step is what keeps the map from filling with windows nobody
   * asks about again: an entry expires in `WINDOW_MS`, and one eviction per
   * attempt drains faster than attempts can arrive while the map is full,
   * because a full map is exactly the state that produces attempts. `canAttempt`
   * still refuses at the ceiling, so the bound is enforced whatever this drops.
   */
  private prune(now: number, keys: readonly string[]): void {
    for (const key of keys) {
      const window = this.attempts.get(key);
      if (window !== undefined && window.expiresAt <= now) {
        // Proof: deleting this window makes "retains pending reservations when the failure window expires"
        // observe six verifications instead of five.
        if (window.inFlight === 0) this.attempts.delete(key);
        else {
          window.failures = 0;
          window.expiresAt = now + WINDOW_MS;
        }
      }
    }
    if (this.attempts.size < MAX_ENTRIES) return;
    for (const [key, window] of this.attempts) {
      // Proof: dropping inFlight makes "does not evict a pending account while pruning a full failure map"
      // observe one admission instead of five.
      if (window.expiresAt <= now && window.inFlight === 0) {
        this.attempts.delete(key);
        return;
      }
    }
  }
}
