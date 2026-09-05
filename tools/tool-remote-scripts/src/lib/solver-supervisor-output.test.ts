import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'bun:test';

import {
  relayManagedContainerOutput,
  type SupervisorOutputFrame,
} from './solver-supervisor-output';

async function* bytes(...values: string[]): AsyncGenerator<Uint8Array> {
  await Promise.resolve();
  for (const value of values) yield new TextEncoder().encode(value);
}

describe('the managed solver output relay', () => {
  it('splits both streams into bounded base64 frames and returns exact byte counts', async () => {
    const sent: SupervisorOutputFrame[] = [];
    const budget = await relayManagedContainerOutput(
      { stdout: bytes('hello'), stderr: bytes('bad') },
      {
        maxPayloadBytes: 3,
        maxStdoutBytes: 10,
        maxStderrBytes: 10,
      },
      {
        send: (frame): Promise<void> => {
          sent.push(frame);
          return Promise.resolve();
        },
      },
    );

    expect(budget).toEqual({ stdoutBytes: 5, stderrBytes: 3 });
    expect(
      sent
        .filter((frame) => frame.type === 'stdout')
        .map((frame) => Buffer.from(frame.payload, 'base64').toString()),
    ).toEqual(['hel', 'lo']);
    expect(
      sent
        .filter((frame) => frame.type === 'stderr')
        .map((frame) => Buffer.from(frame.payload, 'base64').toString()),
    ).toEqual(['bad']);
  });

  it('refuses cumulative overflow before relaying the excess bytes', async () => {
    const sent: SupervisorOutputFrame[] = [];
    let rejection: unknown;
    try {
      await relayManagedContainerOutput(
        { stdout: bytes('abcd'), stderr: bytes() },
        { maxPayloadBytes: 2, maxStdoutBytes: 3, maxStderrBytes: 3 },
        {
          send: (frame): Promise<void> => {
            sent.push(frame);
            return Promise.resolve();
          },
        },
      );
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toMatch(/stdout bytes 4 exceed attempt limit 3/);
    // Proof: deleting the cumulative cap relays a second frame here.
    expect(sent).toHaveLength(1);
  });
});
