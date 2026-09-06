import { BunManagedContainerDriver } from './solver-supervisor-driver';
import {
  listenForSupervisorConnections,
  type SupervisorUnixListenerOptions,
} from './solver-supervisor-listener';
import {
  runManagedSolverAttempt,
  type ManagedContainerDriver,
  type SupervisorLifecycleOptions,
  sweepManagedSolverOrphans,
} from './solver-supervisor-lifecycle';
import {
  hostSupervisorPeerDependencies,
  type SupervisorBackendInspector,
  type SupervisorPeerHostPrimitives,
} from './solver-supervisor-peer';

export interface SolverSupervisorRuntimeOptions {
  readonly connection: SupervisorUnixListenerOptions;
  readonly lifecycle: SupervisorLifecycleOptions;
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
): Promise<ReturnType<SupervisorListen>> {
  await sweepManagedSolverOrphans(driver);
  const peer = hostSupervisorPeerDependencies(driver, host);
  return listen(options.connection, {
    ...peer,
    run: async (frame, channel): Promise<void> => {
      await runManagedSolverAttempt(frame, options.lifecycle, driver, channel);
    },
  });
}
