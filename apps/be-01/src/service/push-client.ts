import { type InternalPushRequest, InternalPushResponse } from '@wbs/contracts';
import {
  DeadlineExceeded,
  delay,
  type Timers,
  untilAborted,
  withinDeadline,
} from '@wbs/runtime-portable';
import { parseOrThrow } from '@wbs/validation';

/**
 * The slice of `fetch` this client calls, so a test can hand it a stub.
 *
 * Narrower than `typeof fetch` on purpose: nothing here calls
 * `fetch.preconnect`, and demanding it made all four stubs in
 * `push-client.test.ts` type errors — invisible, because no `typecheck` target
 * compiled a test file in this repository until 2026-09-02.
 * `globalThis.fetch` still satisfies it.
 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface PushClientOptions {
  gwUrl: string;
  secret: string;
  fetchImpl: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  timers: Timers;
  attemptMs: number;
  overallMs: number;
}

export class PushFailed extends Error {
  override name = 'PushFailed' as const;
}

export class PushClient {
  private readonly fetch: FetchLike;
  private readonly timers: Timers;
  private readonly maxRetries: number;

  constructor(private readonly opts: PushClientOptions) {
    this.fetch = opts.fetchImpl;
    this.timers = opts.timers;
    this.maxRetries = opts.maxRetries ?? 5;
    if (![opts.attemptMs, opts.overallMs].every((ms) => Number.isFinite(ms) && ms > 0))
      throw new Error('deadline budgets must be positive and finite');
    if (!Number.isSafeInteger(this.maxRetries) || this.maxRetries < 0)
      throw new Error('maxRetries must be a nonnegative integer');
  }

  async push(payload: InternalPushRequest, signal?: AbortSignal): Promise<{ delivered: number }> {
    // Proof: replacing the overall budget with 150000 left the bounded-retry
    // test pending at literal 1000ms (push-deadline.test.ts).
    const expiresAt = this.timers.nowMs() + this.opts.overallMs;
    return withinDeadline(
      this.timers,
      this.opts.overallMs,
      (overall) => this.deliver(payload, overall, expiresAt),
      signal,
    );
  }

  /** A permanent HTTP refusal remains terminal even if its bounded diagnostic read fails. */
  private async deliver(
    payload: InternalPushRequest,
    overall: AbortSignal,
    expiresAt: number,
  ): Promise<{ delivered: number }> {
    let backoff = 500;
    // Serialised once, outside the retry loop. The payload does not change
    // between attempts, and the dominant one is `tree_replaced` carrying a whole
    // plan — so a gateway that is down made be-01 stringify every row of the
    // project six times over about a minute.
    const body = JSON.stringify(payload);
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      overall.throwIfAborted();
      const remaining = expiresAt - this.timers.nowMs();
      if (remaining <= 0) throw new DeadlineExceeded('request deadline exceeded');
      const response = { terminal: false };
      let delivered;
      try {
        delivered = await withinDeadline(
          this.timers,
          Math.min(this.opts.attemptMs, remaining),
          async (signal) => {
            const res = await this.fetch(`${this.opts.gwUrl}/internal/push`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'X-Internal-Auth': this.opts.secret,
              },
              body,
              // Proof: omitted signal made both real push-transport tests fail
              // server cancellation: expected true, received false despite deadline settlement.
              signal,
            });
            if (res.status >= 200 && res.status < 300) {
              // Proof: unchecked acknowledgement let the malformed-trusted-reply test
              // resolve instead of rejecting (push-deadline.test.ts).
              const body = parseOrThrow(InternalPushResponse, await res.json());
              return { delivered: body.delivered_to_sockets };
            }
            const transient = res.status >= 500 || res.status === 408 || res.status === 429;
            if (!transient) {
              response.terminal = true;
              const text = await res.text();
              throw new PushFailed(`push failed with ${String(res.status)}: ${text}`);
            }
            await res.body?.cancel();
            if (attempt === this.maxRetries) {
              throw new PushFailed(
                `push failed after ${String(this.maxRetries + 1)} attempts: last=${String(res.status)}`,
              );
            }
            return null;
          },
          overall,
        );
      } catch (error) {
        if (
          // Proof: removing this terminal-status guard made the held-400-body test
          // issue two fetches instead of one after the deadline and retry backoff.
          response.terminal ||
          overall.aborted ||
          (!(error instanceof DeadlineExceeded) && !isTransientNetworkFailure(error)) ||
          attempt === this.maxRetries
        )
          throw error;
        delivered = null;
      }
      if (delivered !== null) return delivered;
      if (this.timers.nowMs() >= expiresAt) throw new DeadlineExceeded('request deadline exceeded');
      const sleep = this.opts.sleep;
      if (sleep === undefined) await delay(this.timers, backoff, overall);
      else await untilAborted(overall, () => sleep(backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
    throw new PushFailed('unreachable');
  }
}

/** Known socket failures are retryable; arbitrary TypeErrors and malformed replies are not. */
// Proof: classifying every Error as transient replaced the unknown-error test
// sentinel with DeadlineExceeded after retries (push-deadline.test.ts).
function isTransientNetworkFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    [
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'EAI_AGAIN',
      'FailedToOpenSocket',
      'ConnectionClosed',
    ].includes(error.code)
  );
}
