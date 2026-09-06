import { describe, expect, it } from 'bun:test';

import {
  SUPERVISOR_PROTOCOL_VERSION,
  type SupervisorStartFrame,
} from './solver-supervisor-protocol';
import { serveSupervisorConnection } from './solver-supervisor-service';

const CALLER_ID = 'a'.repeat(64);
const FRAME: SupervisorStartFrame = {
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

async function* bytes(text: string): AsyncGenerator<Uint8Array> {
  await Promise.resolve();
  yield new TextEncoder().encode(text);
}

async function rejectionOf(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error('expected operation to reject');
}

describe('serveSupervisorConnection', () => {
  it('authenticates the socket before decoding and running its one attempt', async () => {
    const order: string[] = [];
    const writes: string[] = [];

    await serveSupervisorConnection(
      { fd: 17 },
      bytes(`${JSON.stringify(FRAME)}\n`),
      (text) => {
        writes.push(text);
        return Promise.resolve();
      },
      {
        allowedNamePatterns: [/^wbs-dev-src$/],
        maxInputBytes: 2 * 1024 * 1024,
        bindTimeoutMs: 1_000,
        maxSearchWorkers: 2,
        maxMemoryLimitMb: 512,
        now: () => 10_000,
      },
      {
        credentials: () => {
          order.push('credentials');
          return { pid: 4242, uid: 1000, gid: 1000 };
        },
        cgroup: () => {
          order.push('cgroup');
          return Promise.resolve(`0::/system.slice/docker-${CALLER_ID}.scope\n`);
        },
        inspect: (id) => {
          order.push('inspect');
          return Promise.resolve({ id, name: 'wbs-dev-src', image: 'wbs-dev-src:1' });
        },
        run: async (frame, channel) => {
          order.push(`run:${frame.callerId}`);
          await channel.send({ type: 'started', pid: 99 });
        },
      },
    );

    expect(order).toEqual(['credentials', 'cgroup', 'inspect', `run:${CALLER_ID}`]);
    expect(writes).toEqual(['{"type":"started","pid":99}\n']);
  });

  it('does not run when the frame claims a different live backend', async () => {
    let runs = 0;
    const error = await rejectionOf(
      serveSupervisorConnection(
        { fd: 17 },
        bytes(`${JSON.stringify({ ...FRAME, callerId: 'b'.repeat(64) })}\n`),
        () => Promise.resolve(),
        {
          allowedNamePatterns: [/^wbs-dev-src$/],
          maxInputBytes: 2 * 1024 * 1024,
          bindTimeoutMs: 1_000,
          maxSearchWorkers: 2,
          maxMemoryLimitMb: 512,
          now: () => 10_000,
        },
        {
          credentials: () => ({ pid: 4242, uid: 1000, gid: 1000 }),
          cgroup: () => Promise.resolve(`0::/system.slice/docker-${CALLER_ID}.scope\n`),
          inspect: (id) => Promise.resolve({ id, name: 'wbs-dev-src', image: 'wbs-dev-src:1' }),
          run: () => {
            runs += 1;
            return Promise.resolve();
          },
        },
      ),
    );

    // Proof: decoding against the frame claim instead of the authenticated id
    // runs this spoofed connection as another otherwise valid backend.
    expect(error.message).toMatch(/callerId does not match peer caller id/);
    expect(runs).toBe(0);
  });
});
