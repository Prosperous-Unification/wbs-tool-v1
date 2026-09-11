import type { InternalPushRequest } from '@wbs/contracts';

/** Delivers an already-recorded event to connected gateway subscribers. */
export interface PushTransport {
  push(payload: InternalPushRequest, signal?: AbortSignal): Promise<{ delivered: number }>;
}
