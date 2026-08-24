interface AttemptWindow {
  failures: number;
  expiresAt: number;
}

export interface LoginThrottleOptions {
  now?: () => number;
}

const FAILURE_LIMIT = 5;
const WINDOW_MS = 60_000;
const MAX_ENTRIES = 10_000;

/** Fixed-window failure limits that fail closed when their bounded map fills. */
export class LoginThrottle {
  private readonly attempts = new Map<string, AttemptWindow>();
  private readonly now: () => number;

  constructor(options: LoginThrottleOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  canAttempt(username: string, clientIp: string): boolean {
    const now = this.now();
    this.prune(now);
    const keys = this.keys(username, clientIp);
    const withinFailureLimit = keys.every((key) => {
      const window = this.attempts.get(key);
      return window === undefined || window.failures < FAILURE_LIMIT;
    });
    if (!withinFailureLimit) return false;
    const newEntries = keys.filter((key) => !this.attempts.has(key)).length;
    return this.attempts.size + newEntries <= MAX_ENTRIES;
  }

  recordFailure(username: string, clientIp: string): void {
    const now = this.now();
    this.prune(now);
    for (const key of this.keys(username, clientIp)) {
      const current = this.attempts.get(key);
      if (current === undefined) {
        if (this.attempts.size >= MAX_ENTRIES) continue;
        this.attempts.set(key, { failures: 1, expiresAt: now + WINDOW_MS });
      } else {
        current.failures += 1;
      }
    }
  }

  recordSuccess(username: string): void {
    this.attempts.delete(this.usernameKey(username));
  }

  private keys(username: string, clientIp: string): string[] {
    return [this.usernameKey(username), `ip:${clientIp}`];
  }

  private usernameKey(username: string): string {
    return `username:${username.trim().toLowerCase().slice(0, 32)}`;
  }

  private prune(now: number): void {
    for (const [key, window] of this.attempts) {
      if (window.expiresAt <= now) this.attempts.delete(key);
    }
  }
}
