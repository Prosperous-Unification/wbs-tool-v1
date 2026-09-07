import type {
  SupervisorReplyFrame,
  SupervisorStartFrame,
} from '@wbs/contracts/solver/supervisor-protocol';

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
export type SupervisorControl = 'bound' | 'abort' | 'kill' | 'eof' | 'timeout';

export interface ManagedContainerAttachment {
  /** Resolves when `docker attach` closes because the child stopped. */
  readonly closed: Promise<void>;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  write(text: string): Promise<void>;
  closeInput(): Promise<void>;
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
  let deadlineTimer: ManagedDeadlineTimer | undefined;
  let containerWaited = false;
  let containerRemoved = false;
  try {
    deadlineTimer = await driver.armDeadline(
      buildPersistentDeadlineTimerCommands(frame, containerId),
    );
    await driver.start(exactManagedContainerArgs('start', containerId));

    const started = await driver.inspect(exactManagedContainerArgs('inspect', containerId), false);
    if (!Number.isSafeInteger(started.pid) || started.pid < 1) {
      throw new Error('managed solver lifecycle: started container has no positive init PID');
    }
    // Docker CLI refuses to attach to a merely created container. The launcher
    // waits for the bound verdict, so starting before attach cannot expose work.
    const attachment = await driver.attach(exactManagedContainerArgs('attach', containerId));
    await channel.send({ type: 'started', pid: started.pid });
    // Docker can expose child output as soon as start returns. Do not consume
    // the attached streams until the protocol's mandatory first reply is sent.
    const relay = relayManagedContainerOutput(attachment, options.outputLimits, channel).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const relayFailure = relay.then((state) =>
      state.ok ? new Promise<never>(() => undefined) : ('output-error' as const),
    );

    const control = await channel.nextControl();
    if (control === 'bound') {
      await attachment.write('bound\n');
      await attachment.write(`${JSON.stringify(frame.request)}\n`);
      await attachment.closeInput();
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
    containerWaited = true;
    const relayState = await relay;
    const deadlineKilled = await deadlineTimer.hasFired();
    const terminal = terminalFrame(
      await driver.inspect(exactManagedContainerArgs('inspect', containerId), deadlineKilled),
    );
    let cleanupFailure: unknown;
    try {
      await channel.send(terminal);
    } catch (error) {
      // EOF is itself a termination trigger, so terminal delivery can fail on
      // the exact path that most needs host cleanup. Preserve the first failure
      // for the connection log, but never strand the timer or container behind
      // the already-closed coordinator socket.
      cleanupFailure = error;
    }
    try {
      await deadlineTimer.cancel();
    } catch (error) {
      cleanupFailure ??= error;
    }
    try {
      await driver.remove(exactManagedContainerArgs('rm', containerId));
      containerRemoved = true;
    } catch (error) {
      cleanupFailure ??= error;
    }
    if (!relayState.ok) {
      const reason =
        relayState.error instanceof Error ? relayState.error.message : 'unknown failure';
      throw new Error(`managed solver lifecycle: output limit failure: ${reason}`);
    }
    if (cleanupFailure !== undefined) {
      throw cleanupFailure instanceof Error
        ? cleanupFailure
        : new Error('managed solver lifecycle: non-Error cleanup failure');
    }
    return terminal;
  } catch (attemptFailure) {
    if (containerRemoved) throw attemptFailure;

    let timerFailure: unknown;
    if (deadlineTimer !== undefined) {
      try {
        await deadlineTimer.cancel();
      } catch (error) {
        timerFailure = error;
      }
    }
    let stopFailure: unknown;
    let waitFailure: unknown;
    if (!containerWaited) {
      try {
        await driver.kill(exactManagedContainerArgs('kill', containerId));
      } catch (error) {
        stopFailure = error;
      }
      try {
        await driver.wait(exactManagedContainerArgs('wait', containerId));
      } catch (error) {
        waitFailure = error;
      }
    }
    let removeFailure: unknown;
    try {
      await driver.remove(exactManagedContainerArgs('rm', containerId));
    } catch (error) {
      removeFailure = error;
    }

    const cleanupFailure = timerFailure ?? removeFailure;
    if (cleanupFailure !== undefined) {
      const detail = cleanupFailure instanceof Error ? cleanupFailure.message : 'unknown failure';
      throw new Error(`managed solver lifecycle: attempt and cleanup failed: ${detail}`, {
        cause: attemptFailure,
      });
    }
    // A kill or wait can report an already-stopped container. Successful
    // removal is the modeled proof that those intermediate failures are safe.
    void stopFailure;
    void waitFailure;
    throw attemptFailure;
  }
}

/** Clears labelled containers before the supervisor begins accepting sockets. */
export async function sweepManagedSolverOrphans(driver: ManagedContainerDriver): Promise<void> {
  const containerIds = await driver.list(listManagedContainersArgs());
  for (const containerId of containerIds) {
    try {
      await driver.kill(exactManagedContainerArgs('kill', containerId));
    } catch (killFailure) {
      // A persistent deadline timer can stop the container while the
      // restart-always supervisor itself is down. Distinguish that expected
      // state from a failed kill of a still-live orphan before continuing.
      const stopped = await driver.inspect(
        exactManagedContainerArgs('inspect', containerId),
        false,
      );
      if (stopped.pid !== 0) throw killFailure;
      await driver.wait(exactManagedContainerArgs('wait', containerId));
      await driver.remove(exactManagedContainerArgs('rm', containerId));
      continue;
    }
    await driver.wait(exactManagedContainerArgs('wait', containerId));
    await driver.inspect(exactManagedContainerArgs('inspect', containerId), false);
    await driver.remove(exactManagedContainerArgs('rm', containerId));
  }
}
