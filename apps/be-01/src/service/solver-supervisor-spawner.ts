import type { ReservedSolverChild, ReservedSpawner } from './optimization-coordinator';
import {
  connectSolverSupervisor,
  type SolverSupervisorAttempt,
  type SolverSupervisorRequest,
} from './solver-supervisor-client';

export interface SolverSupervisorSpawnerOptions {
  readonly unix: string;
  readonly callerId: string;
  readonly searchWorkers: number;
  readonly memoryLimitMb: number;
  readonly connect?: (request: SolverSupervisorRequest) => Promise<SolverSupervisorAttempt>;
}

/**
 * Maps the coordinator's reserved attempt onto one authenticated host request.
 *
 * The caller contributes only identity, resource requests and the canonical
 * solver request. Image, Docker and systemd authority remain host-owned.
 */
export function solverSupervisorSpawner(options: SolverSupervisorSpawnerOptions): ReservedSpawner {
  const connect = options.connect ?? connectSolverSupervisor;
  return async (request) => {
    const attempt = await connect({
      unix: options.unix,
      callerId: options.callerId,
      projectId: request.key.projectId,
      objective: request.objective,
      attemptToken: request.admission.attemptToken,
      childDeadlineAt: request.admission.childDeadlineAt,
      searchWorkers: options.searchWorkers,
      memoryLimitMb: options.memoryLimitMb,
      request: { ...request.request },
    });
    const child: ReservedSolverChild = {
      pid: attempt.pid,
      stdout: attempt.stdout,
      stderr: attempt.stderr,
      exited: attempt.terminal.then((terminal) => terminal.exitCode),
      terminal: attempt.terminal,
      verdict: attempt.verdict,
      kill: attempt.kill,
    };
    return child;
  };
}
