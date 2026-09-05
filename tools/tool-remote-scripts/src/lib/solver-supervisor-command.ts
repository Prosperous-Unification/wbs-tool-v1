import type { SupervisorStartFrame } from './solver-supervisor-protocol';

export interface ManagedContainerOptions {
  readonly image: string;
  readonly pidsLimit: number;
}

export type ManagedContainerAction = 'attach' | 'start' | 'kill' | 'wait' | 'inspect' | 'rm';

const DIGEST_PINNED_IMAGE = /^[^\s@]+@sha256:[0-9a-f]{64}$/;
const CONTAINER_ID = /^[0-9a-f]{64}$/;

function requireContainerId(containerId: string): void {
  if (!CONTAINER_ID.test(containerId)) {
    throw new Error('managed solver command: invalid full container id');
  }
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

export function buildPersistentDeadlineTimerArgs(
  frame: SupervisorStartFrame,
  containerId: string,
): string[] {
  requireContainerId(containerId);
  return [
    'systemd-run',
    '--user',
    `--unit=wbs-solver-deadline-${frame.attemptToken}`,
    `--on-calendar=@${(frame.childDeadlineAt / 1000).toFixed(3)}`,
    '--timer-property=AccuracySec=1ms',
    '--collect',
    '/usr/bin/docker',
    'kill',
    containerId,
  ];
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

export function exactManagedContainerArgs(
  action: ManagedContainerAction,
  containerId: string,
): string[] {
  requireContainerId(containerId);
  return ['docker', action, containerId];
}
