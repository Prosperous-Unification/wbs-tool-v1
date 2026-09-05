/** The process boundary used by the optimizer's lifecycle launcher. */
export interface SolverLauncherSpawnOptions {
  readonly cmd: readonly string[];
  readonly stdin: 'pipe';
  readonly stdout: 'pipe';
  readonly stderr: 'pipe';
}

/** The exact Bun subprocess surface the coordinator needs. */
export interface SolverLauncherProcess {
  readonly pid: number;
  readonly stdin: {
    readonly write: (chunk: string) => void;
    readonly end: () => void;
  };
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  readonly kill: () => void;
}

export type SolverLauncherSpawn = (options: SolverLauncherSpawnOptions) => SolverLauncherProcess;

export interface SolverLauncherRequest {
  /** The reservation's unforgeable identity, sent as process metadata. */
  readonly attemptToken: string;
  /** The absolute deadline stamped by admission, sent as process metadata. */
  readonly childDeadlineAt: number;
  /** The deterministic solver request. It contains neither token nor clock. */
  readonly request: object;
}

export interface SpawnedSolverLauncher {
  readonly pid: number;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  readonly verdict: (verdict: 'bound' | 'abort') => void;
  readonly kill: () => void;
}

const bunSpawn: SolverLauncherSpawn = (options) =>
  Bun.spawn({
    cmd: [...options.cmd],
    stdin: options.stdin,
    stdout: options.stdout,
    stderr: options.stderr,
  });

/**
 * Spawn the non-solving lifecycle wrapper and retain the one-byte-stream rule.
 *
 * The launcher reads its verdict one byte at a time so it cannot consume any
 * request bytes before `exec`. We therefore write two frames in order: the
 * newline-terminated verdict, then exactly one compact JSON line only on the
 * bound path. Closing stdin makes an incomplete handoff fail closed.
 *
 * Completion, response validation, heartbeats and slot release deliberately
 * stay with the coordinator; this boundary only owns process creation and the
 * bind transport.
 */
export function spawnSolverLauncher(
  request: SolverLauncherRequest,
  spawn: SolverLauncherSpawn = bunSpawn,
): SpawnedSolverLauncher {
  // Serialize before creating a process. A malformed internal request must not
  // leave a launcher waiting for bytes its parent can never produce.
  const encoded = JSON.stringify(request.request);

  const process = spawn({
    cmd: [
      'wbs-solver-launcher',
      '--attempt-token',
      request.attemptToken,
      '--child-deadline-epoch-ms',
      String(request.childDeadlineAt),
    ],
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let decided = false;

  return {
    pid: process.pid,
    stdout: process.stdout,
    stderr: process.stderr,
    exited: process.exited,
    verdict: (verdict) => {
      if (decided) throw new Error('launcher verdict already sent');
      decided = true;
      process.stdin.write(`${verdict}\n`);
      if (verdict === 'bound') process.stdin.write(`${encoded}\n`);
      process.stdin.end();
    },
    kill: () => {
      process.kill();
    },
  };
}
