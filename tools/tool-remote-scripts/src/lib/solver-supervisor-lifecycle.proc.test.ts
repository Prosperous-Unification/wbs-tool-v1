import {
  SUPERVISOR_PROTOCOL_VERSION,
  type SupervisorStartFrame,
} from '@wbs/contracts/solver/supervisor-protocol';
import { describe, expect, it } from 'bun:test';

import { BunManagedContainerDriver } from './solver-supervisor-driver';
import { type ManagedDeadlineTimer, runManagedSolverAttempt } from './solver-supervisor-lifecycle';

const IMAGE = process.env['WBS_SOLVER_ORPHAN_IMAGE'];
const realDockerDescribe = IMAGE === undefined ? describe.skip : describe;
const CALLER_ID = 'a'.repeat(64);

function frame(attemptToken: string): SupervisorStartFrame {
  return {
    type: 'start',
    protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
    callerId: CALLER_ID,
    projectId: '018f3f08-2ef7-7d1c-b645-14f877575d65',
    objective: 'pri',
    attemptToken,
    childDeadlineAt: Date.now() + 60_000,
    searchWorkers: 2,
    memoryLimitMb: 512,
    request: { wireVersion: 1, objective: 'pri', steps: [] },
  };
}

const options = (image: string) => ({
  image,
  pidsLimit: 128,
  maxManagedContainers: 16,
  outputLimits: { maxPayloadBytes: 1024, maxStdoutBytes: 1024, maxStderrBytes: 1024 },
});

const channel = {
  nextControl: () => Promise.resolve('eof' as const),
  send: () => Promise.resolve(),
};

async function containerExists(name: string): Promise<boolean> {
  const child = Bun.spawn(['docker', 'container', 'inspect', name], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  return (await child.exited) === 0;
}

async function forceRemove(name: string): Promise<void> {
  const child = Bun.spawn(['docker', 'rm', '--force', name], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  await child.exited;
}

class ArmFailureDriver extends BunManagedContainerDriver {
  override armDeadline(): Promise<ManagedDeadlineTimer> {
    return Promise.reject(new Error('forced timer setup failure'));
  }
}

class StopAfterStartDriver extends BunManagedContainerDriver {
  override armDeadline(): Promise<ManagedDeadlineTimer> {
    return Promise.resolve({
      hasFired: () => Promise.resolve(false),
      cancel: () => Promise.resolve(),
    });
  }

  override async start(argv: readonly string[]): Promise<void> {
    await super.start(argv);
    const id = argv.at(-1);
    if (id === undefined) throw new Error('real Docker proof: start argv has no container id');
    await super.kill(['docker', 'kill', id]);
  }
}

realDockerDescribe('managed solver exceptional cleanup with real Docker', () => {
  it('removes a merely created container when timer setup fails', async () => {
    if (IMAGE === undefined) throw new Error('real Docker proof enabled without an image');
    const attemptToken = crypto.randomUUID();
    const name = `wbs-solver-${attemptToken}`;
    let rejection: unknown;
    try {
      try {
        await runManagedSolverAttempt(
          frame(attemptToken),
          options(IMAGE),
          new ArmFailureDriver(),
          channel,
        );
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toEqual(new Error('forced timer setup failure'));
      // Proof: real Docker's failed kill and wait on a created container must still reach remove.
      expect(await containerExists(name)).toBe(false);
    } finally {
      await forceRemove(name);
    }
  });

  it('waits and removes after the real container has already stopped', async () => {
    if (IMAGE === undefined) throw new Error('real Docker proof enabled without an image');
    const attemptToken = crypto.randomUUID();
    const name = `wbs-solver-${attemptToken}`;
    let rejection: unknown;
    try {
      try {
        await runManagedSolverAttempt(
          frame(attemptToken),
          options(IMAGE),
          new StopAfterStartDriver(),
          channel,
        );
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).message).toContain('positive init PID');
      // Proof: a second real Docker kill fails, while wait returns and permits exact removal.
      expect(await containerExists(name)).toBe(false);
    } finally {
      await forceRemove(name);
    }
  });
});
