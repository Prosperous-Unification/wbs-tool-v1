import { Buffer } from 'node:buffer';

import type { SupervisorReplyFrame } from './solver-supervisor-protocol';

export type SupervisorOutputFrame = Extract<
  SupervisorReplyFrame,
  { readonly type: 'stdout' | 'stderr' }
>;

export interface SupervisorOutputStreams {
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
}

export interface SupervisorOutputLimits {
  readonly maxPayloadBytes: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
}

export interface SupervisorOutputChannel {
  send(frame: SupervisorOutputFrame): Promise<void>;
}

export interface SupervisorOutputUsage {
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
}

function requireLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`managed solver output: ${name} must be a positive safe integer`);
  }
}

/** Relays decoded bytes without ever emitting an oversized protocol frame. */
export async function relayManagedContainerOutput(
  streams: SupervisorOutputStreams,
  limits: SupervisorOutputLimits,
  channel: SupervisorOutputChannel,
): Promise<SupervisorOutputUsage> {
  requireLimit(limits.maxPayloadBytes, 'maxPayloadBytes');
  requireLimit(limits.maxStdoutBytes, 'maxStdoutBytes');
  requireLimit(limits.maxStderrBytes, 'maxStderrBytes');

  let stdoutBytes = 0;
  let stderrBytes = 0;

  async function relay(
    type: SupervisorOutputFrame['type'],
    source: AsyncIterable<Uint8Array>,
  ): Promise<void> {
    for await (const chunk of source) {
      for (let offset = 0; offset < chunk.byteLength; offset += limits.maxPayloadBytes) {
        const payload = chunk.subarray(offset, offset + limits.maxPayloadBytes);
        const used = type === 'stdout' ? stdoutBytes : stderrBytes;
        const maximum = type === 'stdout' ? limits.maxStdoutBytes : limits.maxStderrBytes;
        const next = used + payload.byteLength;
        if (next > maximum) {
          throw new Error(
            `managed solver output: ${type} bytes ${String(next)} exceed attempt limit ${String(maximum)}`,
          );
        }
        await channel.send({ type, payload: Buffer.from(payload).toString('base64') });
        if (type === 'stdout') stdoutBytes = next;
        else stderrBytes = next;
      }
    }
  }

  await Promise.all([relay('stdout', streams.stdout), relay('stderr', streams.stderr)]);
  return { stdoutBytes, stderrBytes };
}
