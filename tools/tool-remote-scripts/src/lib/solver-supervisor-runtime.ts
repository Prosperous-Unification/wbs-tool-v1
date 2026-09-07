import type { BackendContainerIdentity } from './solver-supervisor-docker-output';
import { BunManagedContainerDriver } from './solver-supervisor-driver';
import {
  type ManagedContainerDriver,
  runManagedSolverAttempt,
  type SupervisorLifecycleOptions,
  sweepManagedSolverOrphans,
} from './solver-supervisor-lifecycle';
import {
  listenForSupervisorConnections,
  type SupervisorUnixListenerOptions,
} from './solver-supervisor-listener';
import {
  hostSupervisorPeerDependencies,
  type SupervisorBackendInspector,
  type SupervisorPeerHostPrimitives,
} from './solver-supervisor-peer';

export interface SolverSupervisorRuntimeOptions {
  readonly connection: SupervisorUnixListenerOptions;
  readonly lifecycle: Omit<SupervisorLifecycleOptions, 'image'>;
  readonly imageFor: (identity: BackendContainerIdentity) => string;
}

export interface SolverSupervisorDriver
  extends ManagedContainerDriver, SupervisorBackendInspector {}

export type SupervisorListen = typeof listenForSupervisorConnections;

/** Sweeps managed orphans before exposing the fully composed production listener. */
export async function startSolverSupervisor(
  options: SolverSupervisorRuntimeOptions,
  driver: SolverSupervisorDriver = new BunManagedContainerDriver(),
  host?: SupervisorPeerHostPrimitives,
  listen: SupervisorListen = listenForSupervisorConnections,
): Promise<Awaited<ReturnType<SupervisorListen>>> {
  await sweepManagedSolverOrphans(driver);
  const peer = hostSupervisorPeerDependencies(driver, host);
  return listen(options.connection, {
    ...peer,
    run: async (frame, channel, identity): Promise<void> => {
      await runManagedSolverAttempt(
        frame,
        { ...options.lifecycle, image: options.imageFor(identity) },
        driver,
        channel,
      );
    },
  });
}
