import type { InternalIdentity } from '../http/endpoint';
import type { AuthenticatedUser } from '../service/auth.service';
import type { ReplayOrchestrator, ReplayOutcome } from '../service/replay-orchestrator';

export interface ReplayGraph {
  replay(resumePoints: Record<string, number>): Promise<Record<string, ReplayOutcome>>;
}

export interface ReplayInput {
  readonly resumePoints: Record<string, number>;
  readonly principal: InternalIdentity | AuthenticatedUser;
}

export type ReplayUseCaseOutcome =
  Record<string, ReplayOutcome> | { readonly status: 'denied'; readonly reason: 'noninternal' };

/** Replays only for a principal admitted by the internal authentication adapter. */
export function replay(
  graph: ReplayGraph | Pick<ReplayOrchestrator, 'replay'>,
  input: ReplayInput,
): Promise<ReplayUseCaseOutcome> {
  if (!('kind' in input.principal)) {
    return Promise.resolve({ status: 'denied', reason: 'noninternal' });
  }
  return graph.replay(input.resumePoints);
}
