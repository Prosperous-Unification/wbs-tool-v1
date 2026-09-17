import { forwardInternal, type InternalResumeResponse, resumeInternal } from '@wbs/contracts';

import { replay } from '../use-cases/replay';
import { bind, type RequestMetadata } from './endpoint';

export interface InternalCallContext {
  clientId: string | null;
  connectionId: string | null;
  traceId: string;
}

export interface InternalDeps {
  onForward: (
    message: unknown,
    ctx: InternalCallContext,
  ) => Promise<{ push_responses?: unknown[] }>;
  onResume: (
    resumePoints: Record<string, number>,
    ctx: InternalCallContext,
  ) => Promise<InternalResumeResponse>;
}

/**
 * Binds the gateway's capability surface. Mounted internal identity runs before
 * parsing; callback failures propagate rather than masquerading as invalid input.
 * Proof: catching any callback error, and separately only ValidationError,
 * returned200 instead of500 in the mounted callback-failure case. Removing the
 * resume binding returned404 instead of200 in the recorded-replay integration case.
 */
export function internalRoutes(deps: InternalDeps) {
  return [
    bind(forwardInternal, async ({ body, request }) => {
      const forwarded = await deps.onForward(body.message, contextFrom(request, body.trace_id));
      return {
        ok: true,
        status: 200,
        body: {
          ack: true as const,
          ...(forwarded.push_responses === undefined
            ? {}
            : { push_responses: forwarded.push_responses }),
        },
      };
    }),
    bind(resumeInternal, async ({ body, request, principal }) => {
      const context = contextFrom(request, body.trace_id);
      const outcome = await replay(
        { replay: (points) => deps.onResume(points, context) },
        {
          resumePoints: Object.fromEntries(Object.entries(body.resume_points)),
          principal,
        },
      );
      if ('status' in outcome)
        throw new Error('internal endpoint admitted a noninternal principal');
      return { ok: true, status: 200, body: outcome };
    }),
  ] as const;
}

/**
 * Missing context headers become null; explicit empty header values stay empty.
 * Proof: nulling clientId or blanking traceId separately changed the captured
 * context in the mounted forms case (http/elysia/internal.test.ts).
 */
function contextFrom(request: RequestMetadata, traceId: string): InternalCallContext {
  return {
    clientId: request.headers.get('x-client-id'),
    connectionId: request.headers.get('x-connection-id'),
    traceId,
  };
}
