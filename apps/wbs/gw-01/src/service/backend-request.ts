import { type Timers, withinDeadline } from '@wbs/runtime-portable';

/** The fetch surface needed by gateway HTTP adapters. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface BackendRequestOptions {
  beUrl: string;
  secret: string;
  fetchImpl: FetchLike;
  timers: Timers;
  attemptMs: number;
  overallMs: number;
}

export interface RequestIdentity {
  clientId: string;
  connectionId: string;
  traceId: string;
}

/**
 * Makes one attempt: forwards may mutate and cannot safely be retried.
 * The shorter attempt/overall budget owns fetch and consumption of its body.
 * Non-success status is terminal before parsing a trusted success contract.
 */
export async function requestBackend<T>(
  opts: BackendRequestOptions,
  route: 'forward' | 'resume',
  body: unknown,
  identity: RequestIdentity,
  parse: (body: unknown) => T,
  parent?: AbortSignal,
): Promise<T> {
  // Proof: removing budget validation issued one fetch instead of zero for invalid
  // budgets in both production clients (request-deadline.test.ts).
  if (![opts.attemptMs, opts.overallMs].every((ms) => Number.isFinite(ms) && ms > 0))
    throw new Error('deadline budgets must be positive and finite');
  // Proof: using only attemptMs left cancellation false at250ms; using only
  // overallMs left settlement false at100ms in request-deadline.test.ts.
  return withinDeadline(
    opts.timers,
    Math.min(opts.attemptMs, opts.overallMs),
    async (signal) => {
      const response = await opts.fetchImpl(`${opts.beUrl}/internal/${route}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-auth': opts.secret,
          'x-client-id': identity.clientId,
          'x-connection-id': identity.connectionId,
        },
        body: JSON.stringify(body),
        // Proof: omitting signal left cancellation false in four deterministic cases;
        // four real gateway transport cases timed out waiting for server cancellation.
        signal,
      });
      // Proof: removing the status check accepted success-shaped503 JSON in both
      // clients instead of Error; the real socket emitted replay data instead of
      // resume_denied (request-deadline.integration.test.ts).
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`${route} failed ${String(response.status)}`);
      }
      return parse(await response.json());
    },
    // Proof: omitting parent propagation made four real close cases time out
    // waiting for cancellation within250ms, before the1000ms attempt deadline.
    parent,
  );
}
