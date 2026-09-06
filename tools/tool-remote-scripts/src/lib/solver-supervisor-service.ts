import type { SupervisorStartFrame } from '@wbs/contracts/solver/supervisor-protocol';

import {
  type SupervisorChannelOptions,
  SupervisorOneAttemptChannel,
} from './solver-supervisor-channel';
import type { BackendContainerIdentity } from './solver-supervisor-docker-output';
import type { SupervisorAttemptChannel } from './solver-supervisor-lifecycle';
import {
  authenticateSupervisorPeer,
  type SupervisorPeerDependencies,
  type SupervisorPeerPolicy,
} from './solver-supervisor-peer';
export interface SupervisorConnectionOptions
  extends SupervisorChannelOptions, SupervisorPeerPolicy {
  readonly maxSearchWorkers: number;
  readonly maxMemoryLimitMb: number;
  readonly now: () => number;
}

export interface SupervisorConnectionDependencies extends SupervisorPeerDependencies {
  run(
    frame: SupervisorStartFrame,
    channel: SupervisorAttemptChannel,
    identity: BackendContainerIdentity,
  ): Promise<void>;
}

/** Authenticates and serves exactly one solver attempt on one accepted stream. */
export async function serveSupervisorConnection(
  socket: unknown,
  input: AsyncIterable<Uint8Array>,
  write: (text: string) => Promise<void>,
  options: SupervisorConnectionOptions,
  dependencies: SupervisorConnectionDependencies,
): Promise<void> {
  const identity = await authenticateSupervisorPeer(socket, options, dependencies);
  const channel = new SupervisorOneAttemptChannel(input, write, options);
  // Proof: solver-supervisor-service.test.ts claims a second valid Docker id
  // and requires refusal before the attempt runner can observe its frame.
  const frame = await channel.readStart({
    now: options.now(),
    peerCallerId: identity.id,
    maxSearchWorkers: options.maxSearchWorkers,
    maxMemoryLimitMb: options.maxMemoryLimitMb,
  });
  await dependencies.run(frame, channel, identity);
}
