import type { SupervisorStartFrame } from '@wbs/contracts/solver/supervisor-protocol';

export interface ManagedContainerOptions {
  readonly image: string;
  readonly pidsLimit: number;
}

export type ManagedContainerAction = 'attach' | 'start' | 'kill' | 'wait' | 'inspect' | 'rm';

export interface PersistentDeadlineTimerCommands {
  readonly arm: readonly string[];
  readonly inspect: readonly string[];
  readonly cancel: readonly string[];
}

const DIGEST_PINNED_IMAGE = /^[^\s@]+@sha256:[0-9a-f]{64}$/;
const CONTAINER_ID = /^[0-9a-f]{64}$/;
const BACKEND_INSPECT_FORMAT =
  '{"id":{{json .Id}},"name":{{json .Name}},"running":{{json .State.Running}},"image":{{json .Config.Image}}}';

function requireContainerId(containerId: string): void {
  if (!CONTAINER_ID.test(containerId)) {
    throw new Error('managed solver command: invalid full container id');
  }
}

/** A millisecond-precise form accepted by the host's systemd calendar parser. */
function systemdCalendarAt(epochMs: number): string {
  // `@<seconds>.<milliseconds>` looks like systemd's epoch syntax but 259
  // rejects its fractional form. An explicit UTC calendar instant preserves
  // the same precision without making the host interpret a local timezone.
  return new Date(epochMs).toISOString().replace('T', ' ').replace('Z', ' UTC');
}

export function buildManagedContainerArgs(
  frame: SupervisorStartFrame,
  options: ManagedContainerOptions,
): string[] {
  if (!DIGEST_PINNED_IMAGE.test(options.image)) {
    throw new Error('managed solver command: image is not digest-pinned');
  }
  if (!Number.isSafeInteger(options.pidsLimit) || options.pidsLimit < 1) {
    throw new Error('managed solver command: pidsLimit must be a positive integer');
  }

  return [
    'docker',
    'create',
    '--name',
    `wbs-solver-${frame.attemptToken}`,
    '--label',
    'wbs-managed-solver=true',
    '--label',
    `wbs-attempt-token=${frame.attemptToken}`,
    '--label',
    `wbs-caller-id=${frame.callerId}`,
    '--label',
    `wbs-project-id=${frame.projectId}`,
    '--label',
    `wbs-objective=${frame.objective}`,
    '--network',
    'none',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=64m',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--init',
    '--restart',
    'no',
    '--memory',
    `${String(frame.memoryLimitMb)}m`,
    '--memory-swap',
    `${String(frame.memoryLimitMb)}m`,
    '--pids-limit',
    String(options.pidsLimit),
    '--interactive',
    '--pull',
    'never',
    '--log-driver',
    'none',
    '--entrypoint',
    'wbs-solver-launcher',
    options.image,
    '--attempt-token',
    frame.attemptToken,
    '--child-deadline-epoch-ms',
    String(frame.childDeadlineAt),
    '--search-workers',
    String(frame.searchWorkers),
    '--memory-limit-mb',
    String(frame.memoryLimitMb),
  ];
}

export function buildPersistentDeadlineTimerCommands(
  frame: SupervisorStartFrame,
  containerId: string,
): PersistentDeadlineTimerCommands {
  requireContainerId(containerId);
  const unit = `wbs-solver-deadline-${frame.attemptToken}`;
  return {
    arm: [
      'systemd-run',
      '--user',
      `--unit=${unit}`,
      `--on-calendar=${systemdCalendarAt(frame.childDeadlineAt)}`,
      '--timer-property=AccuracySec=1ms',
      '--remain-after-exit',
      '/usr/bin/docker',
      'kill',
      containerId,
    ],
    inspect: [
      'systemctl',
      '--user',
      'show',
      `${unit}.service`,
      '--property=ActiveState',
      '--property=Result',
    ],
    cancel: ['systemctl', '--user', 'stop', `${unit}.timer`, `${unit}.service`],
  };
}

export function listManagedContainersArgs(): string[] {
  return [
    'docker',
    'ps',
    '--all',
    '--filter',
    'label=wbs-managed-solver=true',
    '--format',
    '{{.ID}}',
  ];
}

/** Inspects one peer-derived backend id without exposing its environment or labels. */
export function inspectBackendContainerArgs(containerId: string): string[] {
  requireContainerId(containerId);
  // Proof: solver-supervisor-command.test.ts injects a name in place of the
  // full peer id and requires refusal before any Docker argv can be built.
  return ['docker', 'inspect', '--format', BACKEND_INSPECT_FORMAT, containerId];
}

export function exactManagedContainerArgs(
  action: ManagedContainerAction,
  containerId: string,
): string[] {
  requireContainerId(containerId);
  return ['docker', action, containerId];
}
