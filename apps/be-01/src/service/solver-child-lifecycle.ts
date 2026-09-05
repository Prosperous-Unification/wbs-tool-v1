import type { Drizzle } from '../repository/db';
import {
  heartbeatSolverSlot,
  type SolverSlotHeartbeatOutcome,
} from '../repository/optimization-admission';
import { releaseSolverSlot, type SolverSlotRelease } from '../repository/optimization-drain';
import type { SpawnedSolverLauncher } from './solver-launcher-process';

export const SOLVER_HEARTBEAT_INTERVAL_MS = 5_000;

export interface SolverChildSlot extends SolverSlotRelease {
  readonly admittedCancelEpoch: number;
}

export interface SolverChildExit {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type SolverChildLifecycleResult =
  | { readonly kind: 'exited'; readonly code: number }
  | {
      readonly kind: 'cancelled';
      readonly reason: 'requested' | 'generation' | 'lost';
      readonly code: number;
    };

export interface SolverChildLifecycleOptions {
  readonly db: Drizzle;
  readonly slot: SolverChildSlot;
  readonly child: SpawnedSolverLauncher;
  readonly now: () => number;
  /** Called while this attempt still owns its row, before release. */
  readonly onExit: (exit: SolverChildExit) => void | Promise<void>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly heartbeatIntervalMs?: number;
}

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const readText = (stream: ReadableStream<Uint8Array>): Promise<string> =>
  new Response(stream).text();

/**
 * Own one bound child until it exits or durable state cancels it.
 *
 * stdout and stderr start draining immediately, before either stream can fill
 * its pipe and stall the child. Every heartbeat both refreshes the exact token
 * and reads cancellation in the same SQLite transaction. A cancelled or lost
 * child is killed, awaited, and only then released, so SQLite never lends its
 * capacity while the operating-system process may still exist.
 *
 * A normally exited child is handled while the slot remains present because
 * the cache writer uses that token as its final fence. Release runs afterwards
 * even when parsing or storage throws: the process is already gone, and a dead
 * child must not retain capacity until its admitted deadline.
 */
export async function runSolverChildLifecycle(
  options: SolverChildLifecycleOptions,
): Promise<SolverChildLifecycleResult> {
  const completed = Promise.all([
    options.child.exited,
    readText(options.child.stdout),
    readText(options.child.stderr),
  ]).then(([code, stdout, stderr]): SolverChildExit => ({ code, stdout, stderr }));
  const wait = options.sleep ?? sleep;
  const interval = options.heartbeatIntervalMs ?? SOLVER_HEARTBEAT_INTERVAL_MS;

  for (;;) {
    const turn = await Promise.race([
      completed.then((exit) => ({ kind: 'exit' as const, exit })),
      wait(interval).then(() => ({ kind: 'heartbeat' as const })),
    ]);
    if (turn.kind === 'exit') {
      try {
        await options.onExit(turn.exit);
      } finally {
        releaseSolverSlot(options.db, options.slot);
      }
      return { kind: 'exited', code: turn.exit.code };
    }

    const heartbeat: SolverSlotHeartbeatOutcome = heartbeatSolverSlot(options.db, {
      ...options.slot,
      now: options.now(),
    });
    if (heartbeat.kind === 'live') continue;

    options.child.kill();
    const exit = await completed;
    releaseSolverSlot(options.db, options.slot);
    return {
      kind: 'cancelled',
      reason: heartbeat.kind === 'lost' ? 'lost' : heartbeat.reason,
      code: exit.code,
    };
  }
}
