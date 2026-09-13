import { InternalForwardResponse } from '@wbs/contracts';
import { parseOrThrow } from '@wbs/validation';

import {
  type BackendRequestOptions,
  requestBackend,
  type RequestIdentity,
} from './backend-request';

export type { FetchLike } from './backend-request';
export type ForwardClientOptions = BackendRequestOptions;

/** Forwards once with transport cancellation held through the trusted acknowledgement. */
export class ForwardClient {
  constructor(private readonly opts: ForwardClientOptions) {}

  async forward(
    message: unknown,
    ctx: RequestIdentity,
    signal?: AbortSignal,
  ): Promise<InternalForwardResponse> {
    // Proof: bypassing the parser returned {ack: "wrong"} instead of Error in
    // request-deadline.test.ts for the malformed trusted response.
    return requestBackend(
      this.opts,
      'forward',
      { message, trace_id: ctx.traceId },
      ctx,
      (body) => parseOrThrow(InternalForwardResponse, body),
      signal,
    );
  }
}
