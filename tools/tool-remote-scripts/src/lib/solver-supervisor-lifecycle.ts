import {
  buildManagedContainerArgs,
  buildPersistentDeadlineTimerCommands,
  exactManagedContainerArgs,
  listManagedContainersArgs,
  type ManagedContainerOptions,
  type PersistentDeadlineTimerCommands,
} from './solver-supervisor-command';
import {
  relayManagedContainerOutput,
  type SupervisorOutputLimits,
} from './solver-supervisor-output';
import type { SupervisorReplyFrame, SupervisorStartFrame } from './solver-supervisor-protocol';

export type SupervisorControl = 'bound' | 'abort' | 'kill' | 'eof' | 'timeout';

export interface ManagedContainerAttachment {
  /** Resolves when `docker attach` closes because the child stopped. */
  readonly closed: Promise<void>;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  write(text: string): Promise<void>;
}

/** Evidence captured from Docker after a container has stopped. */
export interface ManagedContainerEvidence {
  readonly pid: number;
  readonly exitCode: number;
  readonly oomKilled: boolean;
  /** Set only from the host timer's recorded activation, never inferred from exit text. */
  readonly deadlineKilled: boolean;
}

/**
 * The host-IO seam. Implementations execute only the argv supplied here; the
 * fake records them so unit tests need no Docker or systemd authority.
 */
export interface ManagedContainerDriver {
  list(argv: readonly string[]): Promise<readonly string[]>;
  create(argv: readonly string[]): Promise<string>;
  attach(argv: readonly string[]): Promise<ManagedContainerAttachment>;
  armDeadline(commands: PersistentDeadlineTimerCommands): Promise<ManagedDeadlineTimer>;
  start(argv: readonly string[]): Promise<void>;
  kill(argv: readonly string[]): Promise<void>;
  wait(argv: readonly string[]): Promise<void>;
  inspect(argv: readonly string[], deadlineKilled: boolean): Promise<ManagedContainerEvidence>;
  remove(argv: readonly string[]): Promise<void>;
}

export interface ManagedDeadlineTimer {
  /** True only when systemd records the deadline service completing successfully. */
  hasFired(): Promise<boolean>;
  /** Stops both transient units after terminal evidence has been captured. */
  cancel(): Promise<void>;
}

export interface SupervisorAttemptChannel {
  nextControl(): Promise<SupervisorControl>;
  send(frame: SupervisorReplyFrame): Promise<void>;
}

export interface SupervisorLifecycleOptions extends ManagedContainerOptions {
  readonly maxManagedContainers: number;
  readonly outputLimits: SupervisorOutputLimits;
}

function requireHostCap(maximum: number): void {
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new Error('managed solver lifecycle: host container cap must be a positive integer');
  }
}

function terminalFrame(evidence: ManagedContainerEvidence): SupervisorReplyFrame {
  if (!Number.isSafeInteger(evidence.exitCode) || evidence.exitCode < 0) {
    throw new Error('managed solver lifecycle: Docker returned an invalid exit code');
  }
  return {
    type: 'terminal',
    exitCode: evidence.exitCode,
    deadlineKilled: evidence.deadlineKilled,
    oomKilled: evidence.oomKilled,
  };
}

/**
 * Runs one already-authenticated attempt. The timer is durable before start;
 * no request byte reaches the launcher before `bound`; and removal follows
 * wait, inspect, and terminal delivery.
 */
export async function runManagedSolverAttempt(
  frame: SupervisorStartFrame,
  options: SupervisorLifecycleOptions,
  driver: ManagedContainerDriver,
  channel: SupervisorAttemptChannel,
): Promise<SupervisorReplyFrame> {
  requireHostCap(options.maxManagedContainers);
  const managed = await driver.list(listManagedContainersArgs());
  if (managed.length >= options.maxManagedContainers) {
    throw new Error('managed solver lifecycle: host managed container cap reached');
  }

  const containerId = await driver.create(buildManagedContainerArgs(frame, options));
  const attachment = await driver.attach(exactManagedContainerArgs('attach', containerId));
  const relay = relayManagedContainerOutput(attachment, options.outputLimits, channel).then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const relayFailure = relay.then((state) =>
    state.ok ? new Promise<never>(() => undefined) : ('output-error' as const),
  );
  const deadlineTimer = await driver.armDeadline(
    buildPersistentDeadlineTimerCommands(frame, containerId),
  );
  await driver.start(exactManagedContainerArgs('start', containerId));

  const started = await driver.inspect(exactManagedContainerArgs('inspect', containerId), false);
  if (!Number.isSafeInteger(started.pid) || started.pid < 1) {
    throw new Error('managed solver lifecycle: started container has no positive init PID');
  }
  await channel.send({ type: 'started', pid: started.pid });

  const control = await channel.nextControl();
  if (control === 'bound') {
    await attachment.write('bound\n');
    await attachment.write(`${JSON.stringify(frame.request)}\n`);
    const completion = await Promise.race([
      attachment.closed.then(() => 'closed' as const),
      channel.nextControl(),
      relayFailure,
    ]);
    if (completion !== 'closed') {
      await driver.kill(exactManagedContainerArgs('kill', containerId));
    }
  } else {
    await driver.kill(exactManagedContainerArgs('kill', containerId));
  }

  await driver.wait(exactManagedContainerArgs('wait', containerId));
  const relayState = await relay;
  const deadlineKilled = await deadlineTimer.hasFired();
  const terminal = terminalFrame(
    await driver.inspect(exactManagedContainerArgs('inspect', containerId), deadlineKilled),
  );
  await channel.send(terminal);
  await deadlineTimer.cancel();
  await driver.remove(exactManagedContainerArgs('rm', containerId));
  if (!relayState.ok) {
    const reason = relayState.error instanceof Error ? relayState.error.message : 'unknown failure';
    throw new Error(`managed solver lifecycle: output limit failure: ${reason}`);
  }
  return terminal;
}

/** Clears labelled containers before the supervisor begins accepting sockets. */
export async function sweepManagedSolverOrphans(driver: ManagedContainerDriver): Promise<void> {
  const containerIds = await driver.list(listManagedContainersArgs());
  for (const containerId of containerIds) {
    await driver.kill(exactManagedContainerArgs('kill', containerId));
    await driver.wait(exactManagedContainerArgs('wait', containerId));
    await driver.inspect(exactManagedContainerArgs('inspect', containerId), false);
    await driver.remove(exactManagedContainerArgs('rm', containerId));
  }
}
