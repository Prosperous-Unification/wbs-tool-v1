import { describe, expect, it } from 'bun:test';

import {
  type SupervisorChannelTimer,
  SupervisorOneAttemptChannel,
} from './solver-supervisor-channel';
import {
  SUPERVISOR_PROTOCOL_VERSION,
  type SupervisorStartFrame,
} from './solver-supervisor-protocol';

const CALLER_ID = 'a'.repeat(64);
const START: SupervisorStartFrame = {
  type: 'start',
  protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
  callerId: CALLER_ID,
  projectId: '018f3f08-2ef7-7d1c-b645-14f877575d65',
  objective: 'pri',
  attemptToken: '018f3f08-2ef7-7d1c-b645-14f877575d66',
  childDeadlineAt: 20_000,
  searchWorkers: 2,
  memoryLimitMb: 512,
  request: { wireVersion: 1, objective: 'pri' },
};

async function* chunks(...values: string[]): AsyncGenerator<Uint8Array> {
  await Promise.resolve();
  for (const value of values) yield new TextEncoder().encode(value);
}

async function errorOf(value: Promise<unknown>): Promise<Error> {
  let caught: unknown;
  try {
    await value;
  } catch (error) {
    caught = error;
  }
  if (!(caught instanceof Error)) throw new Error('expected operation to reject');
  return caught;
}

function channel(
  input: AsyncIterable<Uint8Array>,
  writes: string[],
  overrides: { readonly maxInputBytes?: number; readonly timer?: SupervisorChannelTimer } = {},
): SupervisorOneAttemptChannel {
  return new SupervisorOneAttemptChannel(
    input,
    (value) => {
      writes.push(value);
      return Promise.resolve();
    },
    {
      maxInputBytes: overrides.maxInputBytes ?? 2 * 1024 * 1024,
      bindTimeoutMs: 5_000,
      timer: overrides.timer,
    },
  );
}

const context = {
  now: 10_000,
  peerCallerId: CALLER_ID,
  maxSearchWorkers: 2,
  maxMemoryLimitMb: 512,
};

describe('SupervisorOneAttemptChannel', () => {
  it('reads a fragmented start, one decision, one kill, and newline-framed replies', async () => {
    const writes: string[] = [];
    const value = channel(
      chunks(
        JSON.stringify(START).slice(0, 17),
        `${JSON.stringify(START).slice(17)}\n`,
        '{"type":"bound"}\n',
        '{"type":"kill"}\n',
      ),
      writes,
    );

    expect(await value.readStart(context)).toEqual(START);
    expect(await value.nextControl()).toBe('bound');
    expect(await value.nextControl()).toBe('kill');
    await value.send({ type: 'started', pid: 42 });
    expect(writes).toEqual(['{"type":"started","pid":42}\n']);
  });

  it('rejects bytes buffered after start before container creation', async () => {
    const duplicate = `${JSON.stringify(START)}\n${JSON.stringify(START)}\n`;
    expect((await errorOf(channel(chunks(duplicate), []).readStart(context))).message).toMatch(
      /unexpected bytes before started/,
    );
  });

  it('counts every received byte and rejects an unterminated oversize frame', async () => {
    // Proof: counting only completed lines lets an attacker retain an unbounded
    // unterminated frame in the host process.
    const raw = `${JSON.stringify(START)} `;
    expect(
      (
        await errorOf(
          channel(chunks(raw.slice(0, 100), raw.slice(100)), [], {
            maxInputBytes: new TextEncoder().encode(raw).byteLength - 1,
          }).readStart(context),
        )
      ).message,
    ).toMatch(/input bytes/);
  });

  it('rejects malformed, extra-field, duplicate, and out-of-phase controls', async () => {
    for (const control of [
      '{"type":"bound","image":"mine"}',
      '{"type":"start"}',
      '{"type":"unknown"}',
    ]) {
      const value = channel(chunks(`${JSON.stringify(START)}\n`, `${control}\n`), []);
      await value.readStart(context);
      expect((await errorOf(value.nextControl())).message).toMatch(/control frame/);
    }

    const duplicate = channel(
      chunks(`${JSON.stringify(START)}\n`, '{"type":"bound"}\n', '{"type":"abort"}\n'),
      [],
    );
    await duplicate.readStart(context);
    expect(await duplicate.nextControl()).toBe('bound');
    expect((await errorOf(duplicate.nextControl())).message).toMatch(/after decision/);
  });

  it('maps EOF and the bind timer to lifecycle controls', async () => {
    const eof = channel(chunks(`${JSON.stringify(START)}\n`), []);
    await eof.readStart(context);
    expect(await eof.nextControl()).toBe('eof');

    let fire: (() => void) | undefined;
    const timer: SupervisorChannelTimer = {
      after: (_milliseconds, callback) => {
        fire = callback;
        return 7;
      },
      cancel: () => undefined,
    };
    const stalled = channel(
      (async function* (): AsyncGenerator<Uint8Array> {
        yield new TextEncoder().encode(`${JSON.stringify(START)}\n`);
        await new Promise<void>(() => undefined);
      })(),
      [],
      { timer },
    );
    await stalled.readStart(context);
    const pending = stalled.nextControl();
    fire?.();
    expect(await pending).toBe('timeout');
  });
});
