import type { AuthenticatedUser } from '../service/auth.service';
import type { PlanCommand } from '../service/plan-command';
import type { BatchOutcome, PlanCommandRunner } from '../service/plan-commands';

export interface RunCommandBatchGraph {
  run(projectId: string, actorId: string, commands: readonly PlanCommand[]): Promise<BatchOutcome>;
  runDirectory(actorId: string, commands: readonly PlanCommand[]): Promise<BatchOutcome>;
}

export interface RunCommandBatchInput {
  readonly projectId: string | null;
  readonly actor: AuthenticatedUser;
  readonly commands: readonly PlanCommand[];
}

export type RunCommandBatchOutcome =
  BatchOutcome | { readonly ok: false; readonly error: 'insufficient_scope' };

/** Admits one authenticated plan command batch independently of any transport. */
export function runCommandBatch(
  graph: RunCommandBatchGraph | Pick<PlanCommandRunner, 'run' | 'runDirectory'>,
  input: RunCommandBatchInput,
): Promise<RunCommandBatchOutcome> {
  if (!input.actor.scopes.includes('write')) {
    return Promise.resolve({ ok: false, error: 'insufficient_scope' });
  }
  return input.projectId === null
    ? graph.runDirectory(input.actor.id, input.commands)
    : graph.run(input.projectId, input.actor.id, input.commands);
}
