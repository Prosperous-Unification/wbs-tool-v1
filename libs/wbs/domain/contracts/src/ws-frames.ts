/**
 * Every outbound realtime frame, built in one place and serialised here.
 *
 * Separate from `ws.ts` for one reason: this module imports **nothing**, so
 * fe-01 can take it as `@wbs/contracts/ws-frames` without pulling arktype into
 * the browser bundle — the same bargain `plan-export.ts` and
 * `gantt-geometry.ts` make with `@wbs/domain`'s pure modules. The parsers that
 * judge an inbound frame stay in `ws.ts`, where the validator belongs.
 *
 * They serialise because every sender's next move was
 * `socket.send(JSON.stringify(...))`, and there were **fifteen** of those
 * literals across three files in gw-01 and two in fe-01. A frame's field names
 * are this file's now.
 */

/** One subscription's payload, as the wire carries it. */
export function wsData(subscription: string, seq: number, message: unknown): string {
  return JSON.stringify({ subscription, seq, message });
}

/** The answer to a `ping`, which is what keeps an idle socket from being reaped. */
export function wsPong(): string {
  return JSON.stringify({ type: 'pong' });
}

/** The roster, as `who` and every join and leave answer it. */
export function wsPresence(users: readonly string[]): string {
  return JSON.stringify({ type: 'presence', users });
}

/** See {@link ResumeAckFrame} — sent last, counted from the frames actually written. */
export function wsResumeAck(replayed: Record<string, number>): string {
  return JSON.stringify({ type: 'resume_ack', replayed });
}

/** See {@link ResumeDeniedFrame}. */
export function wsResumeDenied(
  subscription: string,
  reason: 'out_of_range' | 'unavailable',
): string {
  return JSON.stringify({ type: 'resume_denied', subscription, reason });
}

/** See {@link ErrorFrame}. */
export function wsError(
  code: string,
  extra: { subscription?: string; retry_after?: number } = {},
): string {
  return JSON.stringify({ type: 'error', code, ...extra });
}

/** A client joining one subscription's fan-out. */
export function wsSubscribe(subscription: string): string {
  return JSON.stringify({ type: 'subscribe', subscription });
}

/** A client asking for everything it missed — see {@link ResumeFrame}. */
export function wsResume(resumePoints: Record<string, number>): string {
  return JSON.stringify({ type: 'resume', resume_points: resumePoints });
}

/** A client leaving one subscription's fan-out. */
export function wsUnsubscribe(subscription: string): string {
  return JSON.stringify({ type: 'unsubscribe', subscription });
}

/** A client asking for the roster rather than waiting for the next join. */
export function wsWho(): string {
  return JSON.stringify({ type: 'who' });
}

/** The heartbeat a client sends to find out whether an idle socket is still there. */
export function wsPing(): string {
  return JSON.stringify({ type: 'ping' });
}
