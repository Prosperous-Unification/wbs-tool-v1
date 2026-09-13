import { parseOrThrow } from '@wbs/validation';
import { describe, expect, it } from 'bun:test';

import {
  WsControlFrame,
  wsData,
  wsError,
  WsFrame,
  wsPong,
  wsPresence,
  wsResume,
  wsResumeAck,
  wsResumeDenied,
  wsSubscribe,
  wsUnsubscribe,
  wsWho,
} from './ws';

describe('WS envelopes', () => {
  it('WsFrame round-trips subscription/seq/message', () => {
    const v = parseOrThrow(WsFrame, { subscription: 'doc:abc', seq: 5, message: { a: 1 } });
    expect(v.seq).toBe(5);
  });

  it('resume_ack control frame parses', () => {
    const v = parseOrThrow(WsControlFrame, {
      type: 'resume_ack',
      replayed: { 'doc:abc': 7 },
    });
    if (v.type !== 'resume_ack') throw new Error('expected resume_ack');
    expect(v.replayed['doc:abc']).toBe(7);
  });

  it('resume_denied control frame parses', () => {
    const v = parseOrThrow(WsControlFrame, {
      type: 'resume_denied',
      subscription: 'doc:abc',
      reason: 'out_of_range',
    });
    expect(v.type).toBe('resume_denied');
  });
});

/**
 * Every frame a builder writes is a frame the parsers here accept.
 *
 * The two halves of this file were written by hand on both sides of the socket
 * until 2026-09-02, and they had drifted twice: gw-01 sent `resume_denied` with
 * `reason: 'unavailable'` against a parser that declared `'out_of_range'` as
 * the only reason, and an `error` frame naming a `subscription` the parser did
 * not declare. Neither showed up as a failure — fe-01 reads `type` and ignores
 * the rest — so the drift was invisible from both ends.
 *
 * The **round trip** is the check: build, `JSON.parse`, and hand it to the
 * parser the other tier judges an inbound frame with. A field renamed in a
 * builder, or an arm dropped from a union, fails here.
 *
 * Proof: `'unavailable'` taken back out of `ResumeDeniedFrame`'s reason,
 * watched failing on `reason must be "out_of_range" (was "unavailable")`; and
 * `wsError`'s `code` renamed to `error_code`, on `code must be a string (was
 * missing)`. Observed 2026-09-02.
 */
describe('the frames a builder writes', () => {
  const parsed = (frame: string): unknown => JSON.parse(frame);

  it('are control frames the parser accepts', () => {
    const built = [
      wsPong(),
      wsPresence(['kat', 'sam']),
      wsResumeAck({ 'project:a': 3 }),
      wsResumeDenied('project:a', 'out_of_range'),
      wsResumeDenied('project:a', 'unavailable'),
      wsError('invalid_payload'),
      wsError('unknown_subscription', { subscription: 'nope' }),
      wsError('backend_unavailable', { retry_after: 5 }),
      wsSubscribe('project:a'),
      wsUnsubscribe('project:a'),
      wsWho(),
      wsResume({ 'project:a': 7 }),
    ];

    for (const frame of built) parseOrThrow(WsControlFrame, parsed(frame));
    // The precondition: an empty list would pass the loop above.
    expect(built).toHaveLength(12);
  });

  it('are data frames the parser accepts', () => {
    const frame = parseOrThrow(WsFrame, parsed(wsData('project:a', 4, { hello: 'world' })));

    expect(frame).toEqual({ subscription: 'project:a', seq: 4, message: { hello: 'world' } });
  });

  it('omit an absent optional field rather than sending it as null', () => {
    // `retry_after` is read by a client deciding when to try again, and a
    // `null` there is not a number — it would parse as a refused frame.
    expect(parsed(wsError('invalid_payload'))).toEqual({
      type: 'error',
      code: 'invalid_payload',
    });
  });
});
