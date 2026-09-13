import { type } from '@wbs/validation';

export const InternalPushRequest = type({
  subscription: 'string',
  seq: 'number',
  message: 'unknown',
  'trace_id?': 'string',
});
export type InternalPushRequest = typeof InternalPushRequest.infer;

export const InternalPushResponse = type({ delivered_to_sockets: 'number' });
export type InternalPushResponse = typeof InternalPushResponse.infer;

export const InternalForwardRequest = type({
  message: 'unknown',
  trace_id: 'string',
});
export type InternalForwardRequest = typeof InternalForwardRequest.infer;

export const InternalForwardResponse = type({
  ack: 'true',
  'push_responses?': 'unknown[]',
});
export type InternalForwardResponse = typeof InternalForwardResponse.infer;

export const InternalResumeRequest = type({
  resume_points: { '[string]': 'number' },
  trace_id: 'string',
});
export type InternalResumeRequest = typeof InternalResumeRequest.infer;

export const ReplayedEvent = type({ seq: 'number', message: 'unknown' });
export type ReplayedEvent = typeof ReplayedEvent.infer;

/**
 * Per subscription: the events the client missed, or a refusal.
 *
 * The replaying variant carries the events themselves rather than a count. They
 * travel back in this response and gw-01 writes them to the one socket that
 * asked, because `/internal/push` fans out to every socket on the subscription —
 * one client reconnecting would make every other client refetch. A count would
 * also be a second statement of `events.length`, free to disagree with it.
 */
export const InternalResumeResponse = type({
  '[string]': [
    { status: "'replaying'", events: ReplayedEvent.array() },
    '|',
    { status: "'denied'", reason: "'out_of_range'" },
  ],
});
export type InternalResumeResponse = typeof InternalResumeResponse.infer;
