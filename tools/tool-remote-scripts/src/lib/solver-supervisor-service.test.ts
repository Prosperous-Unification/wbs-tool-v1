import {
  SUPERVISOR_PROTOCOL_VERSION,
  type SupervisorStartFrame,
} from '@wbs/contracts/solver/supervisor-protocol';
import { describe, expect, it } from 'bun:test';

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
    let runIdentity: unknown;

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
        run: async (frame, channel, identity) => {
          order.push(`run:${frame.callerId}`);
          runIdentity = identity;
          await channel.send({ type: 'started', pid: 99 });
        },
      },
    );

    expect(order).toEqual(['credentials', 'cgroup', 'inspect', `run:${CALLER_ID}`]);
    expect(runIdentity).toEqual({ id: CALLER_ID, name: 'wbs-dev-src', image: 'wbs-dev-src:1' });
    expect(writes).toEqual(['{"type":"started","pid":99}\n']);
  });

  it('resolves an in-container Docker hostname claim to the authenticated full identity', async () => {
    let runCallerId = '';

    await serveSupervisorConnection(
      { fd: 17 },
      bytes(`${JSON.stringify({ ...FRAME, callerId: CALLER_ID.slice(0, 12) })}\n`),
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
        run: (frame) => {
          runCallerId = frame.callerId;
          return Promise.resolve();
        },
      },
    );

    expect(runCallerId).toBe(CALLER_ID);
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

    // Proof: accepting a valid-length claim without matching the authenticated
    // full identity runs this spoofed connection as another live backend.
    expect(error.message).toMatch(/callerId does not match peer caller id/);
    expect(runs).toBe(0);
  });
});
