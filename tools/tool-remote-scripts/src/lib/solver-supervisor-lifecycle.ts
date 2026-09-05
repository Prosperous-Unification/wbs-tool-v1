import {
  buildManagedContainerArgs,
  buildPersistentDeadlineTimerArgs,
  exactManagedContainerArgs,
  listManagedContainersArgs,
  type ManagedContainerOptions,
} from './solver-supervisor-command';
import type { SupervisorReplyFrame, SupervisorStartFrame } from './solver-supervisor-protocol';

export type SupervisorControl = 'bound' | 'abort' | 'kill' | 'eof' | 'timeout';

export interface ManagedContainerAttachment {
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
  armDeadline(argv: readonly string[]): Promise<void>;
  start(argv: readonly string[]): Promise<void>;
  kill(argv: readonly string[]): Promise<void>;
  wait(argv: readonly string[]): Promise<void>;
  inspect(argv: readonly string[]): Promise<ManagedContainerEvidence>;
  remove(argv: readonly string[]): Promise<void>;
}

export interface SupervisorAttemptChannel {
  nextControl(): Promise<SupervisorControl>;
  send(frame: SupervisorReplyFrame): Promise<void>;
}

export interface SupervisorLifecycleOptions extends ManagedContainerOptions {
  readonly maxManagedContainers: number;
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
  await driver.armDeadline(buildPersistentDeadlineTimerArgs(frame, containerId));
  await driver.start(exactManagedContainerArgs('start', containerId));

  const started = await driver.inspect(exactManagedContainerArgs('inspect', containerId));
  if (!Number.isSafeInteger(started.pid) || started.pid < 1) {
    throw new Error('managed solver lifecycle: started container has no positive init PID');
  }
  await channel.send({ type: 'started', pid: started.pid });

  const control = await channel.nextControl();
  if (control === 'bound') {
    await attachment.write('bound\n');
    await attachment.write(`${JSON.stringify(frame.request)}\n`);
  } else {
    await driver.kill(exactManagedContainerArgs('kill', containerId));
  }

  await driver.wait(exactManagedContainerArgs('wait', containerId));
  const terminal = terminalFrame(
    await driver.inspect(exactManagedContainerArgs('inspect', containerId)),
  );
  await channel.send(terminal);
  await driver.remove(exactManagedContainerArgs('rm', containerId));
  return terminal;
}

/** Clears labelled containers before the supervisor begins accepting sockets. */
export async function sweepManagedSolverOrphans(driver: ManagedContainerDriver): Promise<void> {
  const containerIds = await driver.list(listManagedContainersArgs());
  for (const containerId of containerIds) {
    await driver.kill(exactManagedContainerArgs('kill', containerId));
    await driver.wait(exactManagedContainerArgs('wait', containerId));
    await driver.inspect(exactManagedContainerArgs('inspect', containerId));
    await driver.remove(exactManagedContainerArgs('rm', containerId));
  }
}
