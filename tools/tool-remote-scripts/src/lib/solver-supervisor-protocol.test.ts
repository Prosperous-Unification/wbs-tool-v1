import { describe, expect, it } from 'bun:test';

import {
  decodeSupervisorReplyFrame,
  decodeSupervisorStartFrame,
  SUPERVISOR_PROTOCOL_VERSION,
  type SupervisorReplyBudget,
  type SupervisorStartFrame,
} from './solver-supervisor-protocol';

const CALLER_ID = 'a'.repeat(64);
const PROJECT_ID = '018f3f08-2ef7-7d1c-b645-14f877575d65';
const ATTEMPT_TOKEN = '018f3f08-2ef7-7d1c-b645-14f877575d66';

function frame(overrides: Partial<SupervisorStartFrame> = {}): SupervisorStartFrame {
  return {
    type: 'start',
    protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
    callerId: CALLER_ID,
    projectId: PROJECT_ID,
    objective: 'pri',
    attemptToken: ATTEMPT_TOKEN,
    childDeadlineAt: 20_000,
    searchWorkers: 2,
    memoryLimitMb: 512,
    request: { wireVersion: 1, objective: 'pri' },
    ...overrides,
  };
}

const decode = (
  value: unknown,
  overrides: Partial<Parameters<typeof decodeSupervisorStartFrame>[1]> = {},
) =>
  decodeSupervisorStartFrame(JSON.stringify(value), {
    now: 10_000,
    peerCallerId: CALLER_ID,
    maxInputBytes: 2 * 1024 * 1024,
    maxSearchWorkers: 2,
    maxMemoryLimitMb: 512,
    ...overrides,
  });

describe('decodeSupervisorStartFrame', () => {
  it('returns the one authenticated, bounded start frame unchanged', () => {
    expect(decode(frame())).toEqual(frame());
  });

  it('rejects unknown authority and duplicate newline frames', () => {
    // Production break caught: deleting exact-key validation lets a caller
    // choose a Docker image or option the host must own.
    expect(() => decode({ ...frame(), image: 'attacker/image:latest' })).toThrow(
      /unknown key image/,
    );
    expect(() => decode({ ...frame(), network: 'host' })).toThrow(/unknown key network/);
    expect(() =>
      decodeSupervisorStartFrame(`${JSON.stringify(frame())}\n${JSON.stringify(frame())}`, {
        now: 10_000,
        peerCallerId: CALLER_ID,
        maxInputBytes: 2 * 1024 * 1024,
        maxSearchWorkers: 2,
        maxMemoryLimitMb: 512,
      }),
    ).toThrow(/one line/);
  });

  it('rejects oversize input before parsing it', () => {
    // Production break caught: checking characters instead of UTF-8 bytes
    // accepts this multi-byte frame above the host's byte ceiling.
    const raw = JSON.stringify({ ...frame(), request: { note: '€'.repeat(30) } });
    const bytes = new TextEncoder().encode(raw).byteLength;
    expect(raw.length).toBeLessThan(bytes);
    expect(() =>
      decodeSupervisorStartFrame(raw, {
        now: 10_000,
        peerCallerId: CALLER_ID,
        maxInputBytes: bytes - 1,
        maxSearchWorkers: 2,
        maxMemoryLimitMb: 512,
      }),
    ).toThrow(/input bytes/);
  });

  it('rejects invalid or spoofed identities and a spent deadline', () => {
    // Production break caught: trusting callerId instead of the peer-derived
    // id lets one backend claim another backend's host mapping.
    expect(() => decode(frame(), { peerCallerId: 'b'.repeat(64) })).toThrow(/peer caller/);
    expect(() => decode(frame({ callerId: '../docker.sock' }))).toThrow(/callerId/);
    expect(() => decode(frame({ projectId: 'project one' }))).toThrow(/projectId/);
    expect(() => decode(frame({ attemptToken: 'guessable' }))).toThrow(/attemptToken/);
    expect(() => decode(frame({ childDeadlineAt: 10_000 }))).toThrow(/deadline/);
  });

  it('rejects caller resource values above the host caps and mismatched work', () => {
    // Production break caught: taking either numeric field directly into the
    // Docker argv gives a compromised backend resource authority.
    expect(() => decode(frame({ searchWorkers: 3 }))).toThrow(/searchWorkers/);
    expect(() => decode(frame({ searchWorkers: 0 }))).toThrow(/searchWorkers/);
    expect(() => decode(frame({ memoryLimitMb: 513 }))).toThrow(/memoryLimitMb/);
    expect(() => decode(frame({ memoryLimitMb: 0 }))).toThrow(/memoryLimitMb/);
    expect(() => decode(frame({ request: { wireVersion: 1, objective: 'time' } }))).toThrow(
      /request objective/,
    );
  });
});

const REPLY_BUDGET: SupervisorReplyBudget = {
  stdoutBytes: 0,
  stderrBytes: 0,
  maxPayloadBytes: 64 * 1024,
  maxStdoutBytes: 2 * 1024 * 1024,
  maxStderrBytes: 256 * 1024,
};

describe('decodeSupervisorReplyFrame', () => {
  it('counts decoded payload bytes against the matching stream', () => {
    expect(
      decodeSupervisorReplyFrame(
        JSON.stringify({ type: 'stdout', payload: 'aGVsbG8=' }),
        REPLY_BUDGET,
      ),
    ).toEqual({
      frame: { type: 'stdout', payload: 'aGVsbG8=' },
      budget: { ...REPLY_BUDGET, stdoutBytes: 5 },
    });
  });

  it('rejects one oversize payload and cumulative overflow separately', () => {
    // Production break caught: limiting the JSON/base64 characters instead of
    // decoded bytes either rejects valid frames or admits excess child output.
    expect(() =>
      decodeSupervisorReplyFrame(
        JSON.stringify({ type: 'stdout', payload: 'QUFB'.repeat(21_846) }),
        REPLY_BUDGET,
      ),
    ).toThrow(/payload bytes/);
    expect(() =>
      decodeSupervisorReplyFrame(JSON.stringify({ type: 'stdout', payload: 'QUFB' }), {
        ...REPLY_BUDGET,
        stdoutBytes: 8,
        maxStdoutBytes: 10,
      }),
    ).toThrow(/stdout bytes/);
  });

  it('accepts exact started and terminal frames and rejects extra evidence', () => {
    expect(
      decodeSupervisorReplyFrame(JSON.stringify({ type: 'started', pid: 42 }), REPLY_BUDGET),
    ).toEqual({ frame: { type: 'started', pid: 42 }, budget: REPLY_BUDGET });
    expect(
      decodeSupervisorReplyFrame(
        JSON.stringify({ type: 'terminal', exitCode: 137, deadlineKilled: false, oomKilled: true }),
        REPLY_BUDGET,
      ),
    ).toEqual({
      frame: { type: 'terminal', exitCode: 137, deadlineKilled: false, oomKilled: true },
      budget: REPLY_BUDGET,
    });
    expect(() =>
      decodeSupervisorReplyFrame(
        JSON.stringify({
          type: 'terminal',
          exitCode: 137,
          deadlineKilled: false,
          oomKilled: true,
          guessedReason: 'oom',
        }),
        REPLY_BUDGET,
      ),
    ).toThrow(/unknown key guessedReason/);
  });
});
