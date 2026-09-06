import {
  SUPERVISOR_PROTOCOL_VERSION,
  type SupervisorReplyFrame,
  type SupervisorStartFrame,
} from '@wbs/contracts/solver/supervisor-protocol';
import { describe, expect, it } from 'bun:test';

import type {
  ManagedContainerAttachment,
  ManagedContainerEvidence,
  ManagedDeadlineTimer,
  SupervisorAttemptChannel,
} from './solver-supervisor-lifecycle';
import {
  type SolverSupervisorDriver,
  startSolverSupervisor,
  type SupervisorListen,
} from './solver-supervisor-runtime';
import type { SupervisorConnectionDependencies } from './solver-supervisor-service';

const CALLER_ID = 'a'.repeat(64);
const CONTAINER_ID = 'b'.repeat(64);
const IMAGE = `registry.example/wbs-solver@sha256:${'c'.repeat(64)}`;
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

async function* output(...values: string[]): AsyncGenerator<Uint8Array> {
  await Promise.resolve();
  for (const value of values) yield new TextEncoder().encode(value);
}

class FakeDriver implements SolverSupervisorDriver {
  readonly events: string[] = [];
  #lists = 0;
  #inspects = 0;

  list(): Promise<readonly string[]> {
    this.#lists += 1;
    this.events.push(`list:${String(this.#lists)}`);
    return Promise.resolve(this.#lists === 1 ? ['d'.repeat(64)] : []);
  }

  inspectBackend(id: string): Promise<{ id: string; name: string; image: string }> {
    this.events.push(`peer-inspect:${id}`);
    return Promise.resolve({ id, name: 'wbs-dev-src', image: 'wbs-dev-src:1' });
  }

  create(): Promise<string> {
    this.events.push('create');
    return Promise.resolve(CONTAINER_ID);
  }

  attach(): Promise<ManagedContainerAttachment> {
    this.events.push('attach');
    return Promise.resolve({
      closed: Promise.resolve(),
      stdout: output(),
      stderr: output(),
      write: () => Promise.resolve(),
    });
  }

  armDeadline(): Promise<ManagedDeadlineTimer> {
    this.events.push('timer');
    return Promise.resolve({
      hasFired: () => Promise.resolve(false),
      cancel: () => Promise.resolve(),
    });
  }

  start(): Promise<void> {
    this.events.push('start');
    return Promise.resolve();
  }

  kill(): Promise<void> {
    this.events.push('kill');
    return Promise.resolve();
  }

  wait(): Promise<void> {
    this.events.push('wait');
    return Promise.resolve();
  }

  inspect(): Promise<ManagedContainerEvidence> {
    this.#inspects += 1;
    this.events.push(`inspect:${String(this.#inspects)}`);
    return Promise.resolve({
      pid: this.#inspects === 2 ? 4242 : 0,
      exitCode: 0,
      oomKilled: false,
      deadlineKilled: false,
    });
  }

  remove(): Promise<void> {
    this.events.push('remove');
    return Promise.resolve();
  }
}

describe('the solver supervisor runtime composition', () => {
  it('sweeps before listen, then binds host identity and lifecycle to each attempt', async () => {
    const driver = new FakeDriver();
    let dependencies: SupervisorConnectionDependencies | undefined;
    const mapped: string[] = [];
    const listener = { stop: () => undefined };
    const listen = ((_, value) => {
      driver.events.push('listen');
      dependencies = value;
      return listener as ReturnType<SupervisorListen>;
    }) satisfies SupervisorListen;

    const result = await startSolverSupervisor(
      {
        connection: {
          unix: '/run/user/1000/wbs-solver/supervisor.sock',
          allowedNamePatterns: [/^wbs-dev-src$/],
          maxInputBytes: 2 * 1024 * 1024,
          bindTimeoutMs: 5_000,
          maxSearchWorkers: 2,
          maxMemoryLimitMb: 512,
          now: () => 10_000,
        },
        lifecycle: {
          pidsLimit: 128,
          maxManagedContainers: 16,
          outputLimits: {
            maxPayloadBytes: 64 * 1024,
            maxStdoutBytes: 2 * 1024 * 1024,
            maxStderrBytes: 256 * 1024,
          },
        },
        imageFor: (identity) => {
          mapped.push(`${identity.name}:${identity.image}`);
          return IMAGE;
        },
      },
      driver,
      {
        credentials: () => ({ pid: 4242, uid: 1000, gid: 1000 }),
        cgroup: () => Promise.resolve(`0::/system.slice/docker-${CALLER_ID}.scope\n`),
      },
      listen,
    );

    expect(result).toBe(listener as ReturnType<SupervisorListen>);
    // Proof: opening the socket before the awaited sweep moves listen ahead of remove.
    expect(driver.events).toEqual(['list:1', 'kill', 'wait', 'inspect:1', 'remove', 'listen']);
    if (dependencies === undefined) throw new Error('listener dependencies were not composed');
    expect(dependencies.credentials({ fd: 17 }).pid).toBe(4242);
    expect((await dependencies.inspect(CALLER_ID, [/^wbs-dev-src$/])).id).toBe(CALLER_ID);

    const replies: SupervisorReplyFrame[] = [];
    const channel: SupervisorAttemptChannel = {
      nextControl: () => Promise.resolve('abort'),
      send: (frame) => {
        replies.push(frame);
        return Promise.resolve();
      },
    };
    await dependencies.run(FRAME, channel, {
      id: CALLER_ID,
      name: 'wbs-dev-src',
      image: 'wbs-dev-src:1',
    });
    expect(mapped).toEqual(['wbs-dev-src:wbs-dev-src:1']);
    expect(driver.events.slice(6)).toEqual([
      'peer-inspect:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'list:2',
      'create',
      'attach',
      'timer',
      'start',
      'inspect:2',
      'kill',
      'wait',
      'inspect:3',
      'remove',
    ]);
    expect(replies.map((frame) => frame.type)).toEqual(['started', 'terminal']);
  });
});
