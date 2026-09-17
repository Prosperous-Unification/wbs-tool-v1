import { parseOrThrow, ValidationError } from '@wbs/validation';
import { describe, expect, it } from 'bun:test';

import {
  InternalForwardRequest,
  InternalPushRequest,
  InternalResumeRequest,
  InternalResumeResponse,
} from './internal';

describe('internal contracts', () => {
  it('InternalPushRequest accepts a valid payload', () => {
    const v = parseOrThrow(InternalPushRequest, {
      subscription: 'doc:abc',
      seq: 1,
      message: { type: 'ping' },
    });
    expect(v.seq).toBe(1);
  });

  it('InternalPushRequest rejects non-numeric seq', () => {
    expect(() =>
      parseOrThrow(InternalPushRequest, { subscription: 'doc:abc', seq: 'one', message: {} }),
    ).toThrow(ValidationError);
  });

  it('InternalResumeRequest parses resume_points map', () => {
    const v = parseOrThrow(InternalResumeRequest, {
      resume_points: { 'doc:abc': 42, 'user:xyz': 7 },
      trace_id: 't-1',
    });
    expect(v.resume_points['doc:abc']).toBe(42);
  });

  it('InternalResumeResponse carries the replayed events', () => {
    const v = parseOrThrow(InternalResumeResponse, {
      'project:abc': { status: 'replaying', events: [{ seq: 4, message: { type: 'x' } }] },
      'project:def': { status: 'denied', reason: 'out_of_range' },
    });
    expect(v['project:abc']).toEqual({
      status: 'replaying',
      events: [{ seq: 4, message: { type: 'x' } }],
    });
    expect(v['project:def']).toEqual({ status: 'denied', reason: 'out_of_range' });
  });

  it('InternalResumeResponse rejects a replaying answer with no events list', () => {
    // The count-only shape this replaced. Accepting it would let a stub that
    // reads nothing pass for an implementation again.
    expect(() =>
      parseOrThrow(InternalResumeResponse, { 'project:abc': { status: 'replaying', count: 0 } }),
    ).toThrow(ValidationError);
  });

  it('InternalForwardRequest requires trace_id', () => {
    expect(() => parseOrThrow(InternalForwardRequest, { message: { type: 'ping' } })).toThrow(
      ValidationError,
    );
  });
});
