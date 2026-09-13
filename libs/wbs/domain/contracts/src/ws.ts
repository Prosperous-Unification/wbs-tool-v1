import { type } from '@wbs/validation';

/**
 * The realtime vocabulary: every frame that crosses a socket between fe-01 and
 * gw-01, and the one place a frame is built.
 *
 * It was a partial vocabulary until 2026-09-02 and the gaps were not
 * theoretical. gw-01 sends `resume_denied` with `reason: 'unavailable'` when
 * be-01 cannot be reached; this file declared `'out_of_range'` as the only
 * reason. It sends an `error` frame naming the subscription it refused; this
 * file declared no `subscription` on that arm. And `presence`, `subscribe`,
 * `unsubscribe` and `who` were not here at all — eleven outbound frames were
 * hand-written `JSON.stringify` literals in three files, and the two tiers
 * agreed by having been written on the same afternoon.
 *
 * The builders are in `ws-frames.ts` beside this and re-exported here — they
 * **serialise**, because every sender's next move was
 * `socket.send(JSON.stringify(...))`. A frame's field names are this file's
 * now, which is what makes a divergence a compile error rather than a client
 * quietly ignoring a frame it does not recognise.
 */
export const WsFrame = type({
  subscription: 'string',
  seq: 'number',
  message: 'unknown',
});
export type WsFrame = typeof WsFrame.infer;

/**
 * Resume cursors address durable sequence numbers, including -1 for empty history before event zero.
 * Proof: the old lower bound zero made `replays event zero from the covered
 * empty-history cursor on a real socket` fail waiting for resume_ack; the socket
 * had answered invalid_payload and pong instead.
 * Proof: replacing the value constraint with number makes the negative/fractional/infinite/unsafe
 * controller cases receive resume_ack instead of invalid_payload. Removing the array refinement
 * does the same for both array cases and the real-socket malformed-frame regression.
 */
const ResumePoints = type({
  '[string]': '-1 <= number.integer <= 9007199254740991',
}).narrow((points) => !Array.isArray(points));

/** A client asking for everything it missed, per subscription. */
const ResumeFrame = type({
  type: "'resume'",
  resume_points: ResumePoints,
});

/**
 * How many frames were replayed per subscription.
 *
 * Sent **last**, after the replayed frames themselves: an acknowledgement that
 * arrived first would let a client advance its sequence past frames it has not
 * been handed. An empty map is a real answer — see `project-stream.ts`, which
 * refetches rather than reading silence as "you missed nothing".
 */
const ResumeAckFrame = type({
  type: "'resume_ack'",
  replayed: { '[string]': 'number' },
});

/**
 * The gateway cannot replay that subscription, and which of the two reasons.
 *
 * `out_of_range` is a range be-01 no longer holds — retention pruned it.
 * `unavailable` is be-01 not answering at all, so **nothing** is known about
 * the range; the client's only honest move for either is to read the whole
 * project again.
 */
const ResumeDeniedFrame = type({
  type: "'resume_denied'",
  subscription: 'string',
  reason: "'out_of_range' | 'unavailable'",
});

const PingFrame = type({ type: "'ping'" });
const PongFrame = type({ type: "'pong'" });

/** Who is on this connection's project, by username. */
const PresenceFrame = type({
  type: "'presence'",
  users: 'string[]',
});

/** A client joining or leaving one subscription's fan-out. */
const SubscribeFrame = type({
  type: "'subscribe'",
  subscription: 'string',
});
const UnsubscribeFrame = type({
  type: "'unsubscribe'",
  subscription: 'string',
});

/**
 * A client asking for the roster instead of waiting for the next join.
 *
 * A reconnecting client has missed every broadcast sent while it was away, so
 * asking is the only way to a current roster.
 */
const WhoFrame = type({ type: "'who'" });

/**
 * Something was refused, by the gateway's own word for it.
 *
 * `subscription` is present on `unknown_subscription` and absent on the others,
 * because that is the only refusal about a name the client sent.
 */
const ErrorFrame = type({
  type: "'error'",
  code: 'string',
  'subscription?': 'string',
  'retry_after?': 'number',
  'message?': 'string',
});

export const WsControlFrame = ResumeFrame.or(ResumeAckFrame)
  .or(ResumeDeniedFrame)
  .or(PingFrame)
  .or(PongFrame)
  .or(PresenceFrame)
  .or(SubscribeFrame)
  .or(UnsubscribeFrame)
  .or(WhoFrame)
  .or(ErrorFrame);
export type WsControlFrame = typeof WsControlFrame.infer;

/**
 * Client input only, validated and classified before the gateway dispatches it.
 *
 * The forward tag excludes recognized controls, so an invalid control cannot
 * become a backend message merely by carrying subscription and message fields.
 * Proof: putting generic forwarding before validation makes the malformed subscribe,
 * unsubscribe and resume controller cases receive no refusal; the socket case sees only pong.
 * Its regex still infers string in TypeScript; the output's kind discriminant
 * preserves precise control types without a cast after validation. The original
 * frame, including extension fields, is retained unchanged inside that envelope.
 */
export const WsClientFrame = PingFrame.or(WhoFrame)
  .or(SubscribeFrame)
  .or(UnsubscribeFrame)
  .or(ResumeFrame)
  .pipe((frame) => ({ kind: 'control' as const, frame }))
  .or(
    type({
      'type?': type.string.matching(/^(?!(?:ping|who|subscribe|unsubscribe|resume)$)/),
      subscription: 'string',
      message: 'unknown',
    }).pipe((frame) => ({ kind: 'forward' as const, frame })),
  );
export type WsClientFrame = typeof WsClientFrame.infer;

// The builders live in `ws-frames.ts`, which imports nothing: fe-01 takes them
// as `@wbs/contracts/ws-frames`, because this barrel's arktype validators are
// deliberately outside the browser bundle (see `vitest.config.ts`'s alias
// note). Re-exported here so gw-01 has one file to read.
export * from './ws-frames';
