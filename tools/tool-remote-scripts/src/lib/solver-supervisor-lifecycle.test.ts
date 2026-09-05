import { describe, expect, it } from 'bun:test';

import {
  type ManagedContainerAttachment,
  type ManagedContainerDriver,
  type ManagedContainerEvidence,
  runManagedSolverAttempt,
  type SupervisorAttemptChannel,
  type SupervisorControl,
  sweepManagedSolverOrphans,
} from './solver-supervisor-lifecycle';
import {
  SUPERVISOR_PROTOCOL_VERSION,
  type SupervisorReplyFrame,
  type SupervisorStartFrame,
} from './solver-supervisor-protocol';

const CALLER_ID = 'a'.repeat(64);
const CONTAINER_ID = 'b'.repeat(64);
const IMAGE = `registry.example/wbs-be-01@sha256:${'c'.repeat(64)}`;
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
  request: { wireVersion: 1, objective: 'pri', steps: [] },
};

class FakeDriver implements ManagedContainerDriver {
  readonly events: string[] = [];
  readonly writes: string[] = [];
  managed = [CONTAINER_ID];
  inspectCount = 0;
  naturalExit = true;

  list(argv: readonly string[]): Promise<readonly string[]> {
    this.events.push(`list:${argv.join(' ')}`);
    return Promise.resolve(this.managed);
  }

  create(argv: readonly string[]): Promise<string> {
    this.events.push(`create:${argv.slice(0, 2).join(' ')}`);
    return Promise.resolve(CONTAINER_ID);
  }

  attach(argv: readonly string[]): Promise<ManagedContainerAttachment> {
    this.events.push(`attach:${argv.slice(1).join(' ')}`);
    return Promise.resolve({
      closed: this.naturalExit ? Promise.resolve() : new Promise<void>(() => undefined),
      write: (text): Promise<void> => {
        this.writes.push(text);
        this.events.push(`write:${text.trim()}`);
        return Promise.resolve();
      },
    });
  }

  armDeadline(argv: readonly string[]): Promise<void> {
    this.events.push(`timer:${argv[0] ?? ''}`);
    return Promise.resolve();
  }

  start(argv: readonly string[]): Promise<void> {
    this.events.push(`start:${argv.slice(1).join(' ')}`);
    return Promise.resolve();
  }

  wait(argv: readonly string[]): Promise<void> {
    this.events.push(`wait:${argv.slice(1).join(' ')}`);
    return Promise.resolve();
  }

  kill(argv: readonly string[]): Promise<void> {
    this.events.push(`kill:${argv.slice(1).join(' ')}`);
    return Promise.resolve();
  }

  inspect(argv: readonly string[]): Promise<ManagedContainerEvidence> {
    this.inspectCount += 1;
    this.events.push(`inspect${String(this.inspectCount)}:${argv.slice(1).join(' ')}`);
    return Promise.resolve(
      this.inspectCount === 1
        ? { pid: 4242, exitCode: 0, oomKilled: false, deadlineKilled: false }
        : { pid: 0, exitCode: 137, oomKilled: true, deadlineKilled: false },
    );
  }

  remove(argv: readonly string[]): Promise<void> {
    this.events.push(`rm:${argv.slice(1).join(' ')}`);
    return Promise.resolve();
  }
}

function channel(
  controls: readonly SupervisorControl[],
  events: string[],
): SupervisorAttemptChannel {
  let index = 0;
  return {
    nextControl: (): Promise<SupervisorControl> => {
      const control = controls.at(index);
      index += 1;
      return control === undefined
        ? new Promise<SupervisorControl>(() => undefined)
        : Promise.resolve(control);
    },
    send: (frame: SupervisorReplyFrame): Promise<void> => {
      events.push(`send:${frame.type}`);
      return Promise.resolve();
    },
  };
}

describe('the managed solver lifecycle', () => {
  it('arms the persistent timer before start and sends work only after bound', async () => {
    const driver = new FakeDriver();
    const terminal = await runManagedSolverAttempt(
      START,
      { image: IMAGE, pidsLimit: 128, maxManagedContainers: 16 },
      driver,
      channel(['bound'], driver.events),
    );

    expect(terminal).toEqual({
      type: 'terminal',
      exitCode: 137,
      deadlineKilled: false,
      oomKilled: true,
    });
    expect(driver.writes).toEqual(['bound\n', `${JSON.stringify(START.request)}\n`]);
    // Proof: moving armDeadline after start makes this literal order fail.
    expect(driver.events.map((event) => event.split(':')[0])).toEqual([
      'list',
      'create',
      'attach',
      'timer',
      'start',
      'inspect1',
      'send',
      'write',
      'write',
      'wait',
      'inspect2',
      'send',
      'rm',
    ]);
  });

  for (const control of ['abort', 'eof', 'kill', 'timeout'] as const) {
    it(`${control} kills, waits, captures evidence, reports, then removes`, async () => {
      const driver = new FakeDriver();
      await runManagedSolverAttempt(
        START,
        { image: IMAGE, pidsLimit: 128, maxManagedContainers: 16 },
        driver,
        channel([control], driver.events),
      );

      expect(driver.writes).toEqual([]);
      // Proof: removing kill or moving removal before inspect changes this suffix.
      expect(driver.events.map((event) => event.split(':')[0]).slice(-5)).toEqual([
        'kill',
        'wait',
        'inspect2',
        'send',
        'rm',
      ]);
    });
  }

  it('kills on post-bind socket EOF before waiting or removing', async () => {
    const driver = new FakeDriver();
    driver.naturalExit = false;
    await runManagedSolverAttempt(
      START,
      { image: IMAGE, pidsLimit: 128, maxManagedContainers: 16 },
      driver,
      channel(['bound', 'eof'], driver.events),
    );

    expect(driver.writes).toHaveLength(2);
    // Proof: dropping the post-bind control race leaves no kill before wait.
    expect(driver.events.map((event) => event.split(':')[0]).slice(-5)).toEqual([
      'kill',
      'wait',
      'inspect2',
      'send',
      'rm',
    ]);
  });

  it('sweeps every labelled orphan before returning', async () => {
    const driver = new FakeDriver();
    driver.managed = [CONTAINER_ID, 'd'.repeat(64)];
    await sweepManagedSolverOrphans(driver);
    // Proof: removing the per-id wait/inspect sequence leaves a distinct missing event.
    expect(driver.events.map((event) => event.split(':')[0])).toEqual([
      'list',
      'kill',
      'wait',
      'inspect1',
      'rm',
      'kill',
      'wait',
      'inspect2',
      'rm',
    ]);
  });

  it('refuses the host cap before creating another container', async () => {
    const driver = new FakeDriver();
    let rejection: unknown;
    try {
      await runManagedSolverAttempt(
        START,
        { image: IMAGE, pidsLimit: 128, maxManagedContainers: 1 },
        driver,
        channel(['bound'], driver.events),
      );
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toMatch(/managed container cap/);
    // Proof: deleting the cap check admits a create event here.
    expect(driver.events.map((event) => event.split(':')[0])).toEqual(['list']);
  });
});
