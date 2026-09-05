import { describe, expect, it } from 'bun:test';

import {
  buildManagedContainerArgs,
  buildPersistentDeadlineTimerCommands,
  exactManagedContainerArgs,
  listManagedContainersArgs,
} from './solver-supervisor-command';
import {
  SUPERVISOR_PROTOCOL_VERSION,
  type SupervisorStartFrame,
} from './solver-supervisor-protocol';

const CALLER_ID = 'a'.repeat(64);
const CONTAINER_ID = 'b'.repeat(64);
const ATTEMPT_TOKEN = '018f3f08-2ef7-7d1c-b645-14f877575d66';
const IMAGE = `registry.example/wbs-be-01@sha256:${'c'.repeat(64)}`;

const START: SupervisorStartFrame = {
  type: 'start',
  protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
  callerId: CALLER_ID,
  projectId: '018f3f08-2ef7-7d1c-b645-14f877575d65',
  objective: 'pri',
  attemptToken: ATTEMPT_TOKEN,
  childDeadlineAt: 20_000,
  searchWorkers: 2,
  memoryLimitMb: 512,
  request: { wireVersion: 1, objective: 'pri' },
};

describe('the host-owned solver command builder', () => {
  it('builds one fixed, hardened, digest-pinned container command', () => {
    // Production break caught: deleting or reordering any hardening flag, or
    // taking an image/entrypoint option from the caller, changes this literal.
    expect(buildManagedContainerArgs(START, { image: IMAGE, pidsLimit: 128 })).toEqual([
      'docker',
      'create',
      '--name',
      `wbs-solver-${ATTEMPT_TOKEN}`,
      '--label',
      'wbs-managed-solver=true',
      '--label',
      `wbs-attempt-token=${ATTEMPT_TOKEN}`,
      '--label',
      `wbs-caller-id=${CALLER_ID}`,
      '--label',
      `wbs-project-id=${START.projectId}`,
      '--label',
      'wbs-objective=pri',
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
      '512m',
      '--memory-swap',
      '512m',
      '--pids-limit',
      '128',
      '--interactive',
      '--pull',
      'never',
      '--log-driver',
      'none',
      '--entrypoint',
      'wbs-solver-launcher',
      IMAGE,
      '--attempt-token',
      ATTEMPT_TOKEN,
      '--child-deadline-epoch-ms',
      '20000',
      '--search-workers',
      '2',
      '--memory-limit-mb',
      '512',
    ]);
  });

  it('refuses movable images and invalid host PID limits', () => {
    expect(() =>
      buildManagedContainerArgs(START, { image: 'wbs-be-01:latest', pidsLimit: 128 }),
    ).toThrow(/digest-pinned/);
    expect(() => buildManagedContainerArgs(START, { image: IMAGE, pidsLimit: 0 })).toThrow(
      /pidsLimit/,
    );
  });

  it('builds the persistent deadline timer against one exact container id', () => {
    expect(buildPersistentDeadlineTimerCommands(START, CONTAINER_ID)).toEqual({
      arm: [
        'systemd-run',
        '--user',
        `--unit=wbs-solver-deadline-${ATTEMPT_TOKEN}`,
        '--on-calendar=@20.000',
        '--timer-property=AccuracySec=1ms',
        '--remain-after-exit',
        '/usr/bin/docker',
        'kill',
        CONTAINER_ID,
      ],
      inspect: [
        'systemctl',
        '--user',
        'show',
        `wbs-solver-deadline-${ATTEMPT_TOKEN}.service`,
        '--property=ActiveState',
        '--property=Result',
      ],
      cancel: [
        'systemctl',
        '--user',
        'stop',
        `wbs-solver-deadline-${ATTEMPT_TOKEN}.timer`,
        `wbs-solver-deadline-${ATTEMPT_TOKEN}.service`,
      ],
    });
  });

  it('lists by the managed label before allowing exact-id lifecycle commands', () => {
    expect(listManagedContainersArgs()).toEqual([
      'docker',
      'ps',
      '--all',
      '--filter',
      'label=wbs-managed-solver=true',
      '--format',
      '{{.ID}}',
    ]);
    expect(exactManagedContainerArgs('inspect', CONTAINER_ID)).toEqual([
      'docker',
      'inspect',
      CONTAINER_ID,
    ]);
    expect(() => exactManagedContainerArgs('rm', 'all')).toThrow(/container id/);
  });
});
