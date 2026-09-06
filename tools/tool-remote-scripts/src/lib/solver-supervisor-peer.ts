import type { BackendContainerIdentity } from './solver-supervisor-docker-output';
import {
  dockerContainerIdFromPeerCgroup,
  readSupervisorPeerCgroup,
} from './solver-supervisor-peer-cgroup';
import {
  readSupervisorPeerCredentials,
  type SupervisorPeerCredentials,
} from './solver-supervisor-peer-credentials';

export interface SupervisorPeerPolicy {
  readonly allowedNamePatterns: readonly RegExp[];
}

export interface SupervisorPeerDependencies {
  credentials(socket: unknown): SupervisorPeerCredentials;
  cgroup(pid: number): Promise<string>;
  inspect(
    containerId: string,
    allowedNamePatterns: readonly RegExp[],
  ): Promise<BackendContainerIdentity>;
}

export interface SupervisorBackendInspector {
  inspectBackend(
    containerId: string,
    allowedNamePatterns: readonly RegExp[],
  ): Promise<BackendContainerIdentity>;
}

export interface SupervisorPeerHostPrimitives {
  credentials(socket: unknown): SupervisorPeerCredentials;
  cgroup(pid: number): Promise<string>;
}

const HOST_PRIMITIVES: SupervisorPeerHostPrimitives = {
  credentials: readSupervisorPeerCredentials,
  cgroup: readSupervisorPeerCgroup,
};

/** Supplies the authenticated-peer core with only its concrete host authorities. */
export function hostSupervisorPeerDependencies(
  inspector: SupervisorBackendInspector,
  host: SupervisorPeerHostPrimitives = HOST_PRIMITIVES,
): SupervisorPeerDependencies {
  return {
    credentials: (socket) => host.credentials(socket),
    cgroup: (pid) => host.cgroup(pid),
    inspect: (containerId, allowedNamePatterns) =>
      inspector.inspectBackend(containerId, allowedNamePatterns),
  };
}

/** Resolves an accepted socket through kernel identity to one live allowed backend. */
export async function authenticateSupervisorPeer(
  socket: unknown,
  policy: SupervisorPeerPolicy,
  dependencies: SupervisorPeerDependencies,
): Promise<BackendContainerIdentity> {
  const peer = dependencies.credentials(socket);
  const cgroup = await dependencies.cgroup(peer.pid);
  const containerId = dockerContainerIdFromPeerCgroup(cgroup);
  // Proof: solver-supervisor-peer.test.ts gives the peer a host cgroup and
  // requires that Docker inspection is never reached.
  return dependencies.inspect(containerId, policy.allowedNamePatterns);
}
