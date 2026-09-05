import { describe, expect, it } from 'bun:test';

import {
  buildPersistentDeadlineTimerCommands,
  exactManagedContainerArgs,
  listManagedContainersArgs,
} from './solver-supervisor-command';
import {
  BunManagedContainerDriver,
  type ManagedCommandProcess,
  type ManagedCommandSpawn,
} from './solver-supervisor-driver';
import {
  SUPERVISOR_PROTOCOL_VERSION,
  type SupervisorStartFrame,
} from './solver-supervisor-protocol';

const CALLER_ID = 'a'.repeat(64);
const CONTAINER_ID = 'b'.repeat(64);
const CREATED_ID = 'c'.repeat(64);
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

async function* bytes(value: string): AsyncGenerator<Uint8Array> {
  await Promise.resolve();
  yield new TextEncoder().encode(value);
}

async function textOf(source: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of source) text += decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
}

async function rejectionOf(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error('expected operation to reject');
}

interface Reply {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
}

class SpawnRecorder {
  readonly argv: string[][] = [];
  readonly inputModes: ('ignore' | 'pipe')[] = [];
  readonly writes: string[] = [];
  readonly replies: Reply[] = [];

  readonly spawn: ManagedCommandSpawn = (
    argv: readonly string[],
    inputMode: 'ignore' | 'pipe',
  ): ManagedCommandProcess => {
    this.argv.push([...argv]);
    this.inputModes.push(inputMode);
    const reply = this.replies.shift() ?? {};
    return {
      stdout: bytes(reply.stdout ?? ''),
      stderr: bytes(reply.stderr ?? ''),
      exited: Promise.resolve(reply.code ?? 0),
      input:
        inputMode === 'pipe'
          ? {
              write: (text: string): Promise<void> => {
                this.writes.push(text);
                return Promise.resolve();
              },
              flush: (): Promise<void> => Promise.resolve(),
            }
          : null,
    };
  };
}

function inspectOutput(): string {
  return JSON.stringify([{ State: { Pid: 4242, ExitCode: 0, OOMKilled: false } }]);
}

describe('the concrete managed-container driver', () => {
  it('runs Docker commands and decodes only strict create, list, and inspect output', async () => {
    const recorder = new SpawnRecorder();
    recorder.replies.push(
      { stdout: `${CONTAINER_ID}\n${CREATED_ID}\n` },
      { stdout: `${CREATED_ID}\n` },
      { stdout: inspectOutput() },
      {},
      {},
      {},
      {},
    );
    const driver = new BunManagedContainerDriver(recorder.spawn);

    expect(await driver.list(listManagedContainersArgs())).toEqual([CONTAINER_ID, CREATED_ID]);
    expect(await driver.create(['docker', 'create', 'fixed'])).toBe(CREATED_ID);
    expect(await driver.inspect(exactManagedContainerArgs('inspect', CREATED_ID), true)).toEqual({
      pid: 4242,
      exitCode: 0,
      oomKilled: false,
      deadlineKilled: true,
    });
    await driver.start(exactManagedContainerArgs('start', CREATED_ID));
    await driver.kill(exactManagedContainerArgs('kill', CREATED_ID));
    await driver.wait(exactManagedContainerArgs('wait', CREATED_ID));
    await driver.remove(exactManagedContainerArgs('rm', CREATED_ID));

    expect(recorder.argv.slice(3)).toEqual([
      ['docker', 'start', CREATED_ID],
      ['docker', 'kill', CREATED_ID],
      ['docker', 'wait', CREATED_ID],
      ['docker', 'rm', CREATED_ID],
    ]);
    expect(recorder.inputModes).toEqual([
      'ignore',
      'ignore',
      'ignore',
      'ignore',
      'ignore',
      'ignore',
      'ignore',
    ]);
  });

  it('attaches with piped input and exposes both output streams and process closure', async () => {
    const recorder = new SpawnRecorder();
    recorder.replies.push({ stdout: 'answer', stderr: 'warning' });
    const driver = new BunManagedContainerDriver(recorder.spawn);
    const attachment = await driver.attach(exactManagedContainerArgs('attach', CONTAINER_ID));

    await attachment.write('bound\n');
    expect(await textOf(attachment.stdout)).toBe('answer');
    expect(await textOf(attachment.stderr)).toBe('warning');
    await attachment.closed;
    expect(recorder.inputModes).toEqual(['pipe']);
    expect(recorder.writes).toEqual(['bound\n']);
  });

  it('records a successful persistent timer activation and cancels both transient units', async () => {
    const recorder = new SpawnRecorder();
    recorder.replies.push({}, { stdout: 'ActiveState=active\nResult=success\n' }, {});
    const commands = buildPersistentDeadlineTimerCommands(START, CONTAINER_ID);
    const timer = await new BunManagedContainerDriver(recorder.spawn).armDeadline(commands);

    expect(await timer.hasFired()).toBe(true);
    await timer.cancel();
    expect(recorder.argv).toEqual([[...commands.arm], [...commands.inspect], [...commands.cancel]]);
  });

  it('does not call a failed or not-yet-fired deadline service a deadline kill', async () => {
    for (const state of [
      'ActiveState=inactive\nResult=success\n',
      'ActiveState=failed\nResult=exit-code\n',
    ]) {
      const recorder = new SpawnRecorder();
      recorder.replies.push({}, { stdout: state });
      const timer = await new BunManagedContainerDriver(recorder.spawn).armDeadline(
        buildPersistentDeadlineTimerCommands(START, CONTAINER_ID),
      );
      expect(await timer.hasFired()).toBe(false);
    }
  });

  it('rejects command failure and unknown timer state without manufacturing evidence', async () => {
    const failed = new SpawnRecorder();
    failed.replies.push({ stderr: 'daemon refused', code: 7 });
    const commandFailure = await rejectionOf(
      new BunManagedContainerDriver(failed.spawn).list(listManagedContainersArgs()),
    );
    expect(commandFailure.message).toMatch(/docker ps.*exited 7.*daemon refused/);

    const unknown = new SpawnRecorder();
    unknown.replies.push({}, { stdout: 'ActiveState=activating\nResult=success\n' });
    const timer = await new BunManagedContainerDriver(unknown.spawn).armDeadline(
      buildPersistentDeadlineTimerCommands(START, CONTAINER_ID),
    );
    // Proof: defaulting an unrecognised service state to false makes this resolve.
    expect((await rejectionOf(timer.hasFired())).message).toMatch(
      /unexpected deadline service state/,
    );
  });
});
