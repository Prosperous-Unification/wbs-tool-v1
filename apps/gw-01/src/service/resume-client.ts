import { InternalResumeResponse } from '@wbs/contracts';
import { parseOrThrow } from '@wbs/validation';

import {
  type BackendRequestOptions,
  requestBackend,
  type RequestIdentity,
} from './backend-request';

/** Reads replay once; a non-success HTTP response cannot authorize replaying its body. */
export class ResumeClient {
  constructor(private readonly opts: BackendRequestOptions) {}

  async resume(
    points: Record<string, number>,
    ctx: RequestIdentity,
    signal?: AbortSignal,
  ): Promise<InternalResumeResponse> {
    // Proof: bypassing the parser returned {ack: "wrong"} instead of Error in
    // request-deadline.test.ts for the malformed trusted response.
    return requestBackend(
      this.opts,
      'resume',
      { resume_points: points, trace_id: ctx.traceId },
      ctx,
      (body) => parseOrThrow(InternalResumeResponse, body),
      signal,
    );
  }
}
