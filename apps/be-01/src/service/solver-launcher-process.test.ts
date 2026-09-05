import { describe, expect, it } from 'bun:test';

import {
  type SolverLauncherProcess,
  type SolverLauncherSpawnOptions,
  spawnSolverLauncher,
} from './solver-launcher-process';

interface Harness {
  readonly calls: SolverLauncherSpawnOptions[];
  readonly writes: string[];
  readonly process: SolverLauncherProcess;
  readonly ended: () => number;
  readonly killed: () => number;
}

function harness(): Harness {
  const calls: SolverLauncherSpawnOptions[] = [];
  const writes: string[] = [];
  let ended = 0;
  let killed = 0;
  const process: SolverLauncherProcess = {
    pid: 42,
    stdin: {
      write: (chunk) => void writes.push(chunk),
      end: () => void (ended += 1),
    },
    stdout: new ReadableStream<Uint8Array>(),
    stderr: new ReadableStream<Uint8Array>(),
    exited: Promise.resolve(0),
    kill: () => void (killed += 1),
  };
  return {
    calls,
    writes,
    process,
    ended: () => ended,
    killed: () => killed,
  };
}

describe('spawnSolverLauncher', () => {
  it('spawns the lifecycle launcher with identity and absolute deadline only on argv', () => {
    const fake = harness();
    const child = spawnSolverLauncher(
      {
        attemptToken: 'attempt-1',
        childDeadlineAt: 12_345,
        request: { wireVersion: 1, objective: 'pri' },
      },
      (options) => {
        fake.calls.push(options);
        return fake.process;
      },
    );

    expect(fake.calls).toEqual([
      {
        cmd: [
          'wbs-solver-launcher',
          '--attempt-token',
          'attempt-1',
          '--child-deadline-epoch-ms',
          '12345',
        ],
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    ]);
    expect(child.pid).toBe(42);
    expect(child.stdout).toBe(fake.process.stdout);
    expect(child.stderr).toBe(fake.process.stderr);
    expect(child.exited).toBe(fake.process.exited);
    expect(fake.writes).toEqual([]);
  });

  it('writes the bind verdict before exactly one newline-framed request and closes stdin', () => {
    const fake = harness();
    const child = spawnSolverLauncher(
      {
        attemptToken: 'attempt-1',
        childDeadlineAt: 12_345,
        request: { wireVersion: 1, objective: 'time', nested: { value: 'one\nline' } },
      },
      () => fake.process,
    );

    child.verdict('bound');

    expect(fake.writes).toEqual([
      'bound\n',
      '{"wireVersion":1,"objective":"time","nested":{"value":"one\\nline"}}\n',
    ]);
    expect(fake.ended()).toBe(1);
  });

  it('sends no request on abort and delegates termination to the process', () => {
    const fake = harness();
    const child = spawnSolverLauncher(
      {
        attemptToken: 'attempt-1',
        childDeadlineAt: 12_345,
        request: { wireVersion: 1 },
      },
      () => fake.process,
    );

    child.verdict('abort');
    child.kill();

    expect(fake.writes).toEqual(['abort\n']);
    expect(fake.ended()).toBe(1);
    expect(fake.killed()).toBe(1);
  });

  it('refuses a second verdict so a request cannot be written twice', () => {
    const fake = harness();
    const child = spawnSolverLauncher(
      {
        attemptToken: 'attempt-1',
        childDeadlineAt: 12_345,
        request: { wireVersion: 1 },
      },
      () => fake.process,
    );

    child.verdict('bound');

    expect(() => {
      child.verdict('bound');
    }).toThrow('launcher verdict already sent');
    expect(fake.writes).toEqual(['bound\n', '{"wireVersion":1}\n']);
  });
});
