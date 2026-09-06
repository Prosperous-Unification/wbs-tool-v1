import { describe, expect, it } from 'bun:test';

import { authenticateSupervisorPeer } from './solver-supervisor-peer';

const CALLER_ID = 'a'.repeat(64);

async function rejectionOf(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error('expected operation to reject');
}

describe('authenticateSupervisorPeer', () => {
  it('binds the kernel peer pid to one allowed running backend', async () => {
    const calls: unknown[][] = [];
    const identity = await authenticateSupervisorPeer(
      { fd: 17 },
      { allowedNamePatterns: [/^wbs-dev-src$/] },
      {
        credentials: () => ({ pid: 4242, uid: 1000, gid: 1000 }),
        cgroup: (pid) => {
          calls.push(['cgroup', pid]);
          return Promise.resolve(`0::/system.slice/docker-${CALLER_ID}.scope\n`);
        },
        inspect: (id, patterns) => {
          calls.push(['inspect', id, patterns]);
          return Promise.resolve({ id, name: 'wbs-dev-src', image: 'wbs-dev-src:1' });
        },
      },
    );

    expect(identity).toEqual({ id: CALLER_ID, name: 'wbs-dev-src', image: 'wbs-dev-src:1' });
    expect(calls).toEqual([
      ['cgroup', 4242],
      ['inspect', CALLER_ID, [/^wbs-dev-src$/]],
    ]);
  });

  it('never inspects a caller when kernel or proc identity cannot authenticate it', async () => {
    let inspections = 0;
    const inspect = () => {
      inspections += 1;
      return Promise.resolve({ id: CALLER_ID, name: 'wbs-dev-src', image: 'wbs-dev-src:1' });
    };
    const dependencies = {
      credentials: () => ({ pid: 4242, uid: 1000, gid: 1000 }),
      cgroup: () => Promise.resolve('0::/user.slice/user-1000.slice/session-2.scope\n'),
      inspect,
    };

    // Proof: replacing the cgroup-derived id with a frame claim makes this
    // reach inspect and turns the rejection into an accepted live backend.
    expect(
      (
        await rejectionOf(
          authenticateSupervisorPeer({}, { allowedNamePatterns: [/^wbs-dev-src$/] }, dependencies),
        )
      ).message,
    ).toMatch(/peer cgroup/);
    expect(inspections).toBe(0);
  });
});
